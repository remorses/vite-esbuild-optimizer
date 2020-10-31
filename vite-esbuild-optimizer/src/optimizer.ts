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
import { BundleMap, bundleWithEsBuild } from './esbuild'
import { printStats } from './stats'
import fromEntries from 'fromentries'

const moduleRE = /^\/?@modules\//
const HASH_FILE_NAME = '.optimizer-hash'
const DO_NOT_OPTIMIZE = 'DO_NOT_OPTIMIZE'
const READY_EVENT = 'READY_EVENT'
const CACHE_FILE = 'cached.json'

type Cache = {
    bundleMap: BundleMap
    dependenciesPaths: string[]
}

function relativePathFromUrl(url: string) {
    if (url.startsWith('http')) {
        const p = new URL(url).pathname
        return p.startsWith('/') ? p.slice(1) : p
    }
    return url
}

function pathFromUrl(url: string) {
    if (url.startsWith('http')) {
        const p = new URL(url).pathname
        return p
    }
    return url
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
        let { bundleMap = {}, dependenciesPaths = [] } = readCache({
            dest,
            force,
        })

        const hashPath = path.join(dest, HASH_FILE_NAME)

        let ready = new EventEmitter()

        server.once('listening', async function optimize() {
            const depHash = await getDepHash(root)
            if (!force) {
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
            rimraf.sync(dest)
            const {
                bundleMap: nonChachedBundleMap,
                stats,
            } = await bundleWithEsBuild({
                dest,
                entryPoints: dependenciesPaths,
            })

            console.log({ nonChachedBundleMap })

            // create a map with incoming server path -> bundle server path
            bundleMap = nonChachedBundleMap

            await updateCache({
                cache: {
                    bundleMap,
                    dependenciesPaths,
                },
                dest,
            })

            console.log({ bundleMap })

            console.info(printStats(stats))
            console.info('Optimized dependencies\n')
            ready.emit(READY_EVENT)
        })

        let hasWaited = false
        app.use(async (ctx, next) => {
            if (ctx.url === '/index.html' && !hasWaited) {
                // TODO use special request header to not make the url resolver wait
                await once(ready, READY_EVENT)
            }
            hasWaited = true // TODO set ready to false every time we start bundling so that if same module is requested at the sae time it is not rebuilt 2 times or different files do not overwrite the result maps

            await next()

            function redirect(absPath) {
                ctx.type = 'js'
                absPath = '/' + absPath.relative(root, absPath) // format to server path for redirection
                console.log(ctx.path, '->', absPath)
                ctx.redirect(absPath) // TODO instead of mapping from pathname map from real node_module path on disk
            }
            // try to get resolved file
            if (
                ctx.type === 'application/javascript' &&
                moduleRE.test(ctx.path)
            ) {
                const importerDir =
                    ctx.get('referer') &&
                    resolver.requestToFile(
                        pathFromUrl(ctx.get('referer')), // should not be node_module, i can omit importer
                    )

                const resolved = defaultResolver(
                    // TODO here requestToFIle also works even if it should not
                    path.dirname(importerDir),
                    ctx.path.slice(1).replace(moduleRE, ''),
                ) // TODO how can i resolve stuff in linked packages
                // console.log({ resolved })
                if (resolved && bundleMap[resolved]) {
                    let bundlePath = bundleMap[resolved]

                    redirect(bundlePath)
                }
                // console.log({ resolved, importerDir })
            }

            // console.log({bundleMap})

            // else {
            //     console.log(ctx.path)

            //     // try to rebundle dependencies if an import path is not found
            //     const resolvedPath = resolver.requestToFile(ctx.path)
            //     if (
            //         ctx.query[DO_NOT_OPTIMIZE] == null &&
            //         moduleRE.test(ctx.path) &&
            //         isNodeModule(resolvedPath)
            //     ) {
            //         // console.log({ p: resolver.requestToFile(ctx.path) })
            //         console.info(`trying to optimize module for ${ctx.path}`)

            //         const importer = ctx.get('referer')

            //         // console.log({ importer })
            //         if (!importer) {
            //             console.log('no referer for ' + ctx.path)
            //             return // source maps request sometimes have no referer
            //         }
            //         // TODO maybe parse the importer to get other possible importPaths?
            //         // get the imports and rerun optimization
            //         // const port = ctx.server.address()['port']
            //         // const baseUrl = `http://localhost:${port}`
            //         // const entry = addQuery({
            //         //     urlString: new URL(ctx.path, baseUrl).toString(),
            //         //     query: DO_NOT_OPTIMIZE,
            //         // })
            //         // console.log({ entry })
            //         // const res = await traverseEsModules({
            //         //     entryPoints: [entry],
            //         //     stopTraversing: () => true,
            //         //     readFile: readFromUrlOrPath,
            //         //     resolver: urlResolver({
            //         //         baseUrl,
            //         //         root,
            //         //     }),
            //         // })
            //         const newEntrypoints = makeEntrypoints({
            //             requestToFile: resolver.requestToFile,
            //             imports: [
            //                 {
            //                     importPath: ctx.path,
            //                     importer,
            //                     resolvedImportPath: resolvedPath,
            //                 },
            //             ],
            //         })
            //         installEntrypoints = {
            //             ...installEntrypoints,
            //             ...newEntrypoints,
            //         }
            //         const { importMap, stats } = await bundleWithEsBuild({
            //             // make esbuild build incrementally
            //             dest,
            //             installEntrypoints,
            //         })
            //         bundleMap = importMapToResolutionsMap({
            //             dest,
            //             importMap,
            //             root,
            //         })

            //         await updateCache({
            //             cache: {
            //                 installEntrypoints,
            //                 bundleMap,
            //             },
            //             dest,
            //         })

            //         // console.log({ bundleMap, path: ctx.path })

            //         console.info(printStats(stats))
            //         console.info('Optimized dependencies\n')
            //         redirect()
            //     }
            // }
        })
    }
}

async function getDependenciesPathsEsbuild({ entryPoints, root }) {
    const res = await traverseWithEsbuild({
        entryPoints: entryPoints.map((x) =>
            path.resolve(root, x.startsWith('/') ? x.slice(1) : x),
        ),
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
                ) // TODO requestToFile should always accept second argument or linked packages resolution will fail
            )
        },
        resolver: urlResolver({
            root: path.resolve(root),
            baseUrl,
        }),
        readFile: (x, y) => {
            return readFromUrlOrPath(x, y)
        },
    })
    let resolvedFiles = traversalResult
        .map((x) => {
            const importerDir = requestToFile(
                pathFromUrl(x.importer), // should not be node_module, i can omit importer
            )
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

function getPackageNameFromImportPath(importPath: string) {
    const parts = importPath.replace(moduleRE, '').split('/')
    if (parts[0].startsWith('@')) {
        return parts.slice(0, 2).join('/')
    }
    return parts[0]
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

const queryRE = /\?.*$/
const hashRE = /#.*$/

const cleanUrl = (url: string) => {
    return url.replace(hashRE, '').replace(queryRE, '')
}

const sleep = (t) => new Promise((res) => setTimeout(res, t))

function readCache({ dest, force }): Cache {
    const defaultValue = { dependenciesPaths: [], bundleMap: {} }
    if (force) {
        return defaultValue
    }
    try {
        const parsed: Cache = JSON.parse(
            fs.readFileSync(path.join(dest, CACHE_FILE)).toString(),
        )
        // assert all files are present
        Object.values(parsed.bundleMap).map((bundle) => fs.accessSync(bundle))
        parsed.dependenciesPaths.map((bundle) => fs.accessSync(bundle))
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
