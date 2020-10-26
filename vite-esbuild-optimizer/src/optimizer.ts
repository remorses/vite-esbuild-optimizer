import {
    defaultResolver,
    readFromUrlOrPath,
    ResultType,
    traverseEsModules,
    urlResolver,
} from 'es-module-traversal'
import path from 'path'
import fsx from 'fs-extra'
import fs from 'fs-extra'
import findUp from 'find-up'
import { createHash } from 'crypto'
import { promises as fsp } from 'fs'
import url, { URL } from 'url'
import type { ServerPlugin, UserConfig } from 'vite'
import { bundleWithEsBuild } from './esbuild'
import { printStats } from './stats'

const moduleRE = /^\/@modules\//
const HASH_FILE_NAME = '.optimizer-hash'
const DO_NOT_OPTIMIZE = 'DO_NOT_OPTIMIZE'
const CACHE_FILE = 'cached.json' // TODO do i want to cache entrypoints or resolution map?

type Cache = {
    webModulesResolutions: Record<string, string>
    installEntrypoints: Record<string, string>
}

export function esbuildOptimizerPlugin({
    entryPoints,
    link = [], // TODO auto detect linked deps using their resolved path and checking if it is inside a node_modules folder (does this also work for pnp?)
    force = false,
}): ServerPlugin {
    // maps /@modules/module/index.js to /web_modules/module/index.js

    const linkedPackages = new Set(link)

    const isLinkedImportPath = (importPath: string) => {
        return linkedPackages.has(getPackageNameFromImportPath(importPath))
    }

    return ({ app, root, watcher, config, resolver, server }) => {
        const dest = path.join(root, 'web_modules')
        let { webModulesResolutions, installEntrypoints } = readCache({ dest })

        const hashPath = path.join(dest, HASH_FILE_NAME)

        server.once('listening', async () => {
            const depHash = await getDepHash(root)
            if (!force) {
                let prevHash = await fsp
                    .readFile(hashPath, 'utf-8')
                    .catch(() => '')

                // hash is consistent, no need to re-bundle
                if (prevHash === depHash) {
                    console.info('Hash is consistent. Skipping optimization.')
                    // TODO check that every bindle in resolution map exists on disk, if not rerun optimization
                    return
                }
            }
            await updateHash(hashPath, depHash)

            console.info('Optimizing dependencies')

            const port = server.address()['port']

            const baseUrl = `http://localhost:${port}`

            const localUrlResolver = urlResolver({
                root: path.resolve(root),
                baseUrl,
            })

            // serve react refresh runtime
            const traversalResult = await traverseEsModules({
                entryPoints: entryPoints.map((entry) =>
                    formatPathToUrl({ baseUrl, entry }),
                ),
                stopTraversing: (importPath) => {
                    return (
                        moduleRE.test(importPath) &&
                        !isLinkedImportPath(importPath)
                    )
                },
                resolver: localUrlResolver,
                readFile: readFromUrlOrPath,
            })

            // TODO i dont like this mutation
            installEntrypoints = makeEntrypoints({
                isLinkedImportPath,
                requestToFile: resolver.requestToFile,
                imports: traversalResult,
            })
            const { importMap, stats } = await bundleWithEsBuild({
                dest,
                installEntrypoints,
            })

            webModulesResolutions = importMapToResolutionsMap({
                dest,
                importMap,
                root,
            })

            await updateCache({
                cache: {
                    webModulesResolutions,
                    installEntrypoints,
                },
                dest,
            })

            console.info(printStats(stats))
            console.info('Optimized dependencies\n')
        })

        app.use(async (ctx, next) => {
            await next()

            function redirect() {
                ctx.type = 'js'
                ctx.redirect(cleanUrl(webModulesResolutions[ctx.path]))
            }
            // console.log({webModulesResolutions})

            if (webModulesResolutions[ctx.path]) {
                redirect()
            } else {
                console.log(ctx.path)
                if (
                    ctx.query[DO_NOT_OPTIMIZE] == null &&
                    moduleRE.test(ctx.path) &&
                    resolver
                        .requestToFile(resolver.requestToFile(ctx.path))
                        .includes('node_modules') // TODO better check if path is inside node_modules
                ) {
                    // console.log({ p: resolver.requestToFile(ctx.path) })
                    console.info(`trying to optimize module for ${ctx.path}`)

                    const importer = ctx.get('referer')
                        ? new URL(ctx.get('referer')).pathname
                        : ''
                    console.log({ importer })
                    if (!importer) {
                        return // source maps request sometimes have no referer
                    }
                    // TODO maybe parse the importer to get other possible importPaths?
                    // get the imports and rerun optimization
                    // const port = ctx.server.address()['port']
                    // const baseUrl = `http://localhost:${port}`
                    // const entry = addQuery({ // TODO entry is the referer
                    //     urlString: new URL(ctx.path, baseUrl).toString(), // TODO make this better, reuse already existing query
                    //     query: DO_NOT_OPTIMIZE,
                    // })
                    // console.log({ entry })
                    // const res = await traverseEsModules({
                    //     entryPoints: [entry],
                    //     stopTraversing: () => true,
                    //     readFile: readFromUrlOrPath,
                    //     resolver: urlResolver({
                    //         baseUrl,
                    //         root,
                    //     }),
                    // })
                    const newEntrypoints = makeEntrypoints({
                        isLinkedImportPath,
                        requestToFile: resolver.requestToFile,
                        imports: [
                            {
                                importPath: ctx.path,
                                importer,
                            },
                        ],
                    })
                    installEntrypoints = {
                        ...installEntrypoints,
                        ...newEntrypoints,
                    }
                    const { importMap, stats } = await bundleWithEsBuild({
                        // make esbuild build incrementally
                        dest,
                        installEntrypoints,
                    })
                    webModulesResolutions = importMapToResolutionsMap({
                        dest,
                        importMap,
                        root,
                    })

                    await updateCache({
                        cache: {
                            installEntrypoints,
                            webModulesResolutions,
                        },
                        dest,
                    })

                    console.log({ webModulesResolutions, path: ctx.path })

                    console.info(printStats(stats))
                    console.info('Optimized dependencies\n')
                    redirect()
                }
            }
        })
    }
}

function importMapToResolutionsMap({ importMap, dest, root }) {
    const resolutionsMap = {}
    Object.keys(importMap.imports).forEach((importPath) => {
        let resolvedFile = path.posix.resolve(
            dest,
            importMap.imports[importPath],
        )

        // make url always /web_modules/...
        resolvedFile = '/' + path.posix.relative(root, resolvedFile)

        // console.log(importPath, '-->', resolvedFile)
        resolutionsMap[importPath] = resolvedFile
    })
    return resolutionsMap
}

export function addQuery({ urlString, query }) {
    const parsed = new URL(urlString)
    // console.log({ parsed })
    parsed.searchParams.append(query, '')
    return parsed.toString()
}

function makeEntrypoints({
    imports,
    requestToFile,
    isLinkedImportPath,
}: {
    imports: Pick<ResultType, 'importPath' | 'importer'>[]
    requestToFile: Function
    isLinkedImportPath
}) {
    const installEntrypoints = Object.assign(
        {},
        ...imports
            .filter(
                (x) =>
                    moduleRE.test(x.importPath) && // TODO paths here could have an added js extension // TODO only add the js extension if exporting to outer directory
                    !isLinkedImportPath(x.importPath),
            )
            .map((x) => {
                const cleanImportPath = cleanUrl(x.importPath) //.replace(moduleRE, '')

                // console.log(url.parse(x.importer).pathname)
                // TODO here i get paths with an added .js extension
                let importerDir = path.dirname(
                    requestToFile(
                        // TODO request to file should handle the added .js extension
                        url.parse(x.importer).path, // .replace(moduleRE, ''),
                    ),
                )
                // importerDir = path.posix.join(
                //     root,
                //     importerDir.startsWith('/')
                //         ? importerDir.slice(1)
                //         : importerDir,
                // )
                const importPath = cleanImportPath.replace(moduleRE, '')
                const file = defaultResolver(importerDir, importPath) // TODO what if this file is outside root, how deep will the web_modules folder? will it work?
                return {
                    [cleanImportPath]: file,
                }
            }),
    )
    return installEntrypoints
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

function readCache({ dest }): Cache {
    try {
        return JSON.parse(
            fs.readFileSync(path.join(dest, CACHE_FILE)).toString(),
        )
    } catch {
        return { installEntrypoints: {}, webModulesResolutions: {} }
    }
}

async function updateCache({ dest, cache }: { cache: Cache; dest: string }) {
    await fsp.writeFile(
        path.join(dest, CACHE_FILE),
        JSON.stringify(cache, null, 4),
    )
}
