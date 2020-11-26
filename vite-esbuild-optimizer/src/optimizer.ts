import rimraf from 'rimraf'
import { EventEmitter, once } from 'events'

import {
    defaultResolver,
    readFromUrlOrPath,
    TraversalResultType,
    traverseEsModules,
    urlResolver,
} from 'es-module-traversal'

import { traverseWithEsbuild } from 'es-module-traversal/dist/traverseEsbuild'
import path from 'path'
import fsx from 'fs-extra'
import fs from 'fs-extra'
import findUp from 'find-up'
import { createHash } from 'crypto'
import { promises as fsp } from 'fs'
import url, { URL } from 'url'
import type { ServerPlugin, UserConfig } from 'vite'
import { resolveOptimizedCacheDir } from 'vite/dist/node/optimizer'
import { BundleMap, bundleWithEsBuild } from './esbuild'
import { printStats } from './stats'
import fromEntries from 'fromentries'
import { isUrl } from './support'

const moduleRE = /^\/?@modules\//
const HASH_FILE_NAME = '.optimizer-hash'
const DO_NOT_OPTIMIZE = 'DO_NOT_OPTIMIZE'
const READY_EVENT = 'READY_EVENT'
const CACHE_FILE = 'cached.json'
const ANALYSIS_FILE = '_analysis.json'

type Cache = {
    bundleMap: BundleMap
    dependenciesPaths: string[]
}

export function esbuildOptimizerServerPlugin({
    entryPoints,
    force = false,
}): ServerPlugin {
    // maps /@modules/module/index.js to /web_modules/module/index.js

    // const linkedPackages = new Set(link)

    return function plugin({ app, root, watcher, config, resolver, server }) {
        force = force || config['force']
        const dest = path.join(root, 'web_modules/node_modules')
        let { bundleMap = {}, dependenciesPaths = [], stale } = readCache({
            dest,
            force,
        })

        const hashPath = path.join(dest, HASH_FILE_NAME)

        let ready = new EventEmitter()

        server.once('listening', async function optimize() {
            const depHash = await getDepHash(root)
            if (!force && !stale) {
                let prevHash = await fsp
                    .readFile(hashPath, 'utf-8')
                    .catch(() => '')

                // hash is consistent, no need to re-bundle
                if (prevHash === depHash) {
                    console.info('Hash is consistent. Skipping optimization.')
                    // TODO check that every bundle in resolution map exists on disk, if not rerun optimization
                    ready.emit(READY_EVENT)
                    return
                }
            }
            await updateHash(hashPath, depHash)

            console.info('Optimizing dependencies')

            const port = server.address()['port']

            // TODO this could be implemented with the esbuild traverser
            // get node_modules resolved paths traversing entrypoints
            dependenciesPaths = await getDependenciesPaths({
                entryPoints,
                root,

                requestToFile: resolver.requestToFile,
                baseUrl: `http://localhost:${port}`,
            })

            // bundle and create a map from node module path -> bundle path on disk
            await fs.remove(dest)
            const {
                bundleMap: nonCachedBundleMap,
                analysis,
                stats,
            } = await bundleWithEsBuild({
                dest,
                entryPoints: dependenciesPaths,
            })

            const analysisFile = path.join(
                resolveOptimizedCacheDir(root),
                ANALYSIS_FILE,
            )
            await fsx.createFile(analysisFile)
            // console.log({ analysis })
            await fs.writeFile(analysisFile, JSON.stringify(analysis, null, 4))

            // create a map with incoming server path -> bundle server path
            bundleMap = nonCachedBundleMap

            await updateCache({
                cache: {
                    bundleMap,
                    dependenciesPaths,
                },
                dest,
            })

            // console.log({ bundleMap })

            console.info(printStats(stats))
            console.info('Optimized dependencies\n')
            ready.emit(READY_EVENT)
        })

        let hasWaited = false
        app.use(async (ctx, next) => {
            if (ctx.url === '/index.html' && !hasWaited) {
                // TODO use special request header to not make the url resolver wait
                await once(ready, READY_EVENT)
                hasWaited = true // TODO set ready to false every time we start bundling so that if same module is requested at the sae time it is not rebuilt 2 times or different files do not overwrite the result maps
            }

            await next()

            function redirect(absPath) {
                ctx.type = 'js'
                absPath = '/' + path.relative(root, absPath) // format to server path for redirection
                console.log(ctx.path, '->', absPath)
                ctx.redirect(absPath) // TODO instead of mapping from pathname map from real node_module path on disk
            }
            // try to get resolved file
            if (moduleRE.test(ctx.path)) {
                const importer =
                    ctx.get('referer') &&
                    resolver.requestToFile(
                        pathFromUrl(ctx.get('referer')), // should not be node_module, i can omit importer
                    )

                const resolved = defaultResolver(
                    importer ? path.dirname(importer) : root,
                    ctx.path.slice(1).replace(moduleRE, ''),
                )
                // TODO resolved files paths should be relative to root, and os agnostic
                // console.log({ resolved })
                if (resolved && bundleMap[resolved]) {
                    let bundlePath = bundleMap[resolved]
                    // TODO check if file exist before?

                    return redirect(bundlePath)
                }
            }

            if (
                moduleRE.test(ctx.path) &&
                isNodeModule(resolver.requestToFile(ctx.url))
            ) {
                await fs.remove(hashPath)
                return
                console.error(
                    `WARNING: using a non optimized dependency '${ctx.url.replace(
                        moduleRE,
                        '',
                    )}'\nRestart the server to optimize dependencies again`,
                )
                // delete cache to optimize on next start
            }
        })
    }
}

async function getDependenciesPathsEsbuild({
    entryPoints,
    root,
    requestToFile,
}) {
    const res = await traverseWithEsbuild({
        entryPoints: entryPoints.map((x) => requestToFile(x)),
    })
    return res.map((x) => x.resolvedImportPath)
}

// returns list of paths of all dependencies found traversing the entrypoints
async function getDependenciesPaths({
    entryPoints,
    baseUrl,
    root,
    requestToFile,
}) {
    // serve react refresh runtime
    const traversalResult = await traverseEsModules({
        entryPoints: entryPoints.map((entry) =>
            formatPathToUrl({ baseUrl, entry }),
        ),
        stopTraversing: (importPath, context) => {
            // TODO add importer dir to stopTraversing
            // console.log({ importPath, context })

            return (
                moduleRE.test(importPath) &&
                isNodeModule(
                    defaultResolver(
                        // TODO here resolve fails for non node_modules is it ok?
                        requestToFile(pathFromUrl(context)),
                        relativePathFromUrl(importPath).replace(moduleRE, ''),
                    ),
                )
            )
        },
        resolver: urlResolver({
            root: path.resolve(root),
            baseUrl,
        }),
    })
    let resolvedFiles = traversalResult
        .map((x) => {
            const importerDir = requestToFile(pathFromUrl(x.importer))
            // console.log({ importerDir: x.importer })

            const resolved = defaultResolver(
                importerDir,
                relativePathFromUrl(x.resolvedImportPath).replace(moduleRE, ''), // TODO in esbuild these path will be already resolved
            )
            return resolved
        })
        .filter((x) => isNodeModule(x))
    resolvedFiles = Array.from(new Set(resolvedFiles))
    return resolvedFiles
}

export function addQuery({ urlString, query }) {
    const parsed = new URL(urlString)
    // console.log({ parsed })
    parsed.searchParams.append(query, '')
    return parsed.toString()
}

function isNodeModule(p: string) {
    const res = p.includes('node_modules')
    // console.log({ isNodeModule: res, p })
    return res
}

function formatPathToUrl({ entry, baseUrl }) {
    entry = entry.startsWith('/') ? entry.slice(1) : path.posix.normalize(entry)
    return new URL(entry, baseUrl).toString()
}

// hash assumes that import paths can only grow when installed dependencies grow, this is not the case for deep paths like `lodash/path`, in these cases you will need to use `--force`
async function getDepHash(root: string) {
    const lockfileLoc = await findUp(
        ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'],
        {
            cwd: root,
        },
    )
    if (!lockfileLoc) {
        return
    }
    const content = await (await fsp.readFile(lockfileLoc, 'utf-8')).toString()
    return createHash('sha1').update(content).digest('base64').trim()
}

async function updateHash(hashPath: string, newHash: string) {
    await fsx.createFile(hashPath)
    await fsx.writeFile(hashPath, newHash.trim())
}

function readCache({ dest, force }): Cache & { stale: boolean } {
    const defaultValue = { dependenciesPaths: [], bundleMap: {}, stale: false }
    if (force) {
        return defaultValue
    }
    try {
        const parsed: Cache = JSON.parse(
            fs.readFileSync(path.join(dest, CACHE_FILE)).toString(),
        )
        // assert all files are present
        Object.values(parsed.bundleMap).map((bundle) => fs.accessSync(bundle))
        parsed.dependenciesPaths.map((bundle) => fs.existsSync(bundle))
        return {
            ...parsed,
            stale: false,
        }
    } catch {
        fsx.removeSync(path.join(dest, CACHE_FILE))
        return defaultValue
    }
}

async function updateCache({ dest, cache }: { cache: Cache; dest: string }) {
    await fsp.writeFile(
        path.join(dest, CACHE_FILE),
        JSON.stringify(cache, null, 4),
    )
}

function relativePathFromUrl(url: string) {
    if (!isUrl(url)) {
        return url
    }
    const p = pathFromUrl(url)
    return p.startsWith('/') ? p.slice(1) : p
}

function pathFromUrl(req: string) {
    if (isUrl(req)) {
        const p = url.parse(req).path
        return p
    }
    return req
}
