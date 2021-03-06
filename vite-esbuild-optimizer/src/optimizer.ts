import { createHash } from 'crypto'
import {
    defaultResolver,
    TraversalResultType,
    traverseEsModules,
    urlResolver,
} from 'es-module-traversal'
// import { traverseWithEsbuild } from 'es-module-traversal/dist/traverseEsbuild'
import findUp from 'find-up'
import { promises as fsp } from 'fs'
import { default as fs, default as fsx } from 'fs-extra'
import path from 'path'
import slash from 'slash'
import url, { URL } from 'url'
import type { ServerPlugin } from 'vite'
import { resolveOptimizedCacheDir } from 'vite/dist/node/optimizer'
import { BundleMap, bundleWithEsBuild } from './esbuild'
import { printStats } from './stats'
import { isUrl, Lock, osAgnosticPath } from './support'

const moduleRE = /^\/?@modules\//
const HASH_FILE_NAME = '.optimizer-hash'

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

        let mutex = new Lock()

        server.once('listening', async function optimize() {
            try {
                const depHash = await getDepHash(root)
                if (!force && !stale) {
                    let prevHash = await fsp
                        .readFile(hashPath, 'utf-8')
                        .catch(() => '')

                    // hash is consistent, no need to re-bundle
                    if (prevHash === depHash) {
                        console.info(
                            'Hash is consistent. Skipping optimization.',
                        )
                        mutex.ready()
                        return
                    }
                }
                await updateHash(hashPath, depHash)

                console.info('Optimizing dependencies')

                const port = server.address()['port']

                // TODO traversal could be implemented with the esbuild traverser if not using vue...
                // get node_modules resolved paths traversing entrypoints
                dependenciesPaths = await getDependenciesPaths({
                    entryPoints,
                    root,
                    requestToFile: resolver.requestToFile,
                    baseUrl: `http://localhost:${port}`,
                })

                // if (dependenciesPaths.length) {
                //     console.info(
                //         `Found dependencies:\n${dependenciesPaths
                //             .map((x) => `  ${x}`)
                //             .join('\n')} `,
                //     )
                // }

                // bundle and create a map from node module path -> bundle path on disk
                await fs.remove(dest)
                await fs.remove(resolveOptimizedCacheDir(root))
                const {
                    bundleMap: nonCachedBundleMap,
                    analysis,
                    stats,
                } = await bundleWithEsBuild({
                    dest,
                    entryPoints: dependenciesPaths.map((x) =>
                        path.resolve(root, x),
                    ),
                })

                const analysisFile = path.join(
                    resolveOptimizedCacheDir(root),
                    ANALYSIS_FILE,
                )
                await fsx.createFile(analysisFile)
                // console.log({ analysis })
                await fs.writeFile(
                    analysisFile,
                    JSON.stringify(analysis, null, 4),
                )

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
            } catch (e) {
                console.error(e)
            } finally {
                mutex.ready()
            }
        })

        app.use(async (ctx, next) => {
            if (
                !mutex.isReady &&
                ctx.get('user-agent') !== 'es-module-traversal'
            ) {
                await mutex.wait()
            }

            await next()

            function redirect(absPath) {
                ctx.type = 'js'
                absPath = '/' + path.relative(root, absPath) // format to server path for redirection
                console.log(ctx.path, '->', absPath)
                ctx.redirect(absPath)
            }
            // try to get resolved file
            if (moduleRE.test(ctx.path)) {
                const importer =
                    ctx.get('referer') &&
                    resolver.requestToFile(
                        pathFromUrl(ctx.get('referer')), // should not be node_module, i can omit importer
                    )

                const resolved = osAgnosticPath(
                    defaultResolver(
                        importer ? path.dirname(importer) : root,
                        ctx.path.slice(1).replace(moduleRE, ''),
                    ),
                )
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
                // console.error(
                //     `WARNING: using a non optimized dependency '${ctx.path}'\nRestart the server to optimize dependencies again`,
                // )
                // delete cache to optimize on next start
            }
        })
    }
}

// TODO use esbuild to traverse for faster traverse times
// async function getDependenciesPathsEsbuild({
//     entryPoints,
//     root,
//     requestToFile,
// }) {
//     const res = await traverseWithEsbuild({
//         entryPoints: entryPoints.map((x) => requestToFile(x)),
//     })
//     return res.map((x) => x.resolvedImportPath)
// }

// returns list of paths of all dependencies found traversing the entrypoints
async function getDependenciesPaths({
    entryPoints,
    baseUrl,
    root,
    requestToFile,
}) {
    // serve react refresh runtime
    const traversalResult: Array<
        Omit<TraversalResultType, 'importPath'>
    > = await traverseEsModules({
        entryPoints: entryPoints.map((entry) =>
            formatPathToUrl({ baseUrl, entry }),
        ),
        stopTraversing: (modulePath) => {
            return modulePath.includes('/@modules')
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
                relativePathFromUrl(x.resolvedImportPath).replace(moduleRE, ''),
            )
            return resolved
        })
        .filter((x) => isNodeModule(x))
        .map((x) => slash(path.relative(root, x)))
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
