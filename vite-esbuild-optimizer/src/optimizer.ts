import {
    defaultResolver,
    makeServerFunctions,
    traverseEsModules,
} from 'es-module-traversal'
import path from 'path'
import fsx from 'fs-extra'
import findUp from 'find-up'
import { createHash } from 'crypto'
import { promises as fsp } from 'fs'
import url from 'url'
import type { ServerPlugin, UserConfig } from 'vite'
import { bundleWithEsBuild } from './esbuild'
import { printStats } from './stats'

const moduleRE = /^\/@modules\//
const HASH_FILE_NAME = '.optimizer-hash'

export function esbuildOptimizerPlugin({
    entryPoints,
    link = [], // TODO auto detect linked deps using their resolved path and checking if it is inside a node_modules folder (does this also work for pnp?)
    force = false,
}): ServerPlugin {
    // maps /@modules/module/index.js to /web_modules/module/index.js
    const webModulesResolutions = new Map<string, string>()

    const linkedPackages = new Set(link)

    let alreadyProcessed = false
    return ({ app, root, watcher, config, resolver }) => {
        const dest = path.join(root, 'web_modules')
        const hashPath = path.join(dest, HASH_FILE_NAME)
        app.use(async (ctx, next) => {
            await next()

            if (webModulesResolutions.has(ctx.path)) {
                ctx.type = 'js'
                const resolved = webModulesResolutions.get(ctx.path)
                console.info(ctx.path, '-->', resolved)
                ctx.redirect(resolved) // redirect will change referer and resolutions to relative imports will work correctly
                // redirect will also work in export because all relative imports will be converted to absolute paths by the server
                // TODO redirect will not work with export if the extension of the compiled module is different than the old one
            }

            // TODO do the optimization outside routes? to do this i need to know the port and have a way to know when app is listening
            if (
                alreadyProcessed ||
                !ctx.response.is('js') ||
                !entryPoints.includes(ctx.url)
            ) {
                return
            }

            const depHash = await getDepHash(root)
            if (!force) {
                let prevHash = await fsp
                    .readFile(hashPath, 'utf-8')
                    .catch(() => '')

                // hash is consistent, no need to re-bundle
                if (prevHash === depHash) {
                    console.info('Hash is consistent. Skipping optimization.')
                    alreadyProcessed = true
                    return
                }
            }
            await updateHash(hashPath, depHash)

            console.info('Optimizing dependencies')

            alreadyProcessed = true

            const port = ctx.port

            const isLinkedImportPath = (importPath: string) => {
                return linkedPackages.has(
                    getPackageNameFromImportPath(importPath),
                )
            }

            // serve react refresh runtime
            const traversalResult = await traverseEsModules({
                entryPoints: entryPoints.map((entry) => {
                    entry = entry.startsWith('/')
                        ? entry.slice(1)
                        : path.posix.normalize(entry)
                    return `http://localhost:${port}/${entry}`
                }),
                stopTraversing: (importPath) => {
                    return (
                        moduleRE.test(importPath) &&
                        !isLinkedImportPath(importPath)
                    )
                },

                ...makeServerFunctions({
                    // downloadFilesToDir: dest,
                    port,
                    root: path.resolve(root),
                }),
            })

            const installEntrypoints = Object.assign(
                {},
                ...traversalResult
                    .filter(
                        (x) =>
                            moduleRE.test(x.importPath) &&
                            !isLinkedImportPath(x.importPath),
                    )
                    .map((x) => {
                        const cleanImportPath = cleanUrl(x.importPath) //.replace(moduleRE, '')

                        let importerDir = path.posix.dirname(
                            resolver.requestToFile(
                                // TODO does requestToFile always work?
                                url.parse(x.importer).pathname,
                            ),
                        )
                        // importerDir = path.posix.join(
                        //     root,
                        //     importerDir.startsWith('/')
                        //         ? importerDir.slice(1)
                        //         : importerDir,
                        // )
                        const importPath = cleanImportPath.replace(moduleRE, '')
                        console.log({ importerDir })
                        const file = defaultResolver(importerDir, importPath)
                        return {
                            [cleanImportPath]: file,
                        }
                    }),
            )

            // console.log({ installEntrypoints })
            const { importMap, stats } = await bundleWithEsBuild({
                dest,
                installEntrypoints,
            })

            Object.keys(importMap.imports).forEach((importPath) => {
                let resolvedFile = path.posix.resolve(
                    dest,
                    importMap.imports[importPath],
                )

                // make url always /web_modules/...
                resolvedFile = '/' + path.posix.relative(root, resolvedFile)

                // console.log(importPath, '-->', resolvedFile)
                webModulesResolutions.set(importPath, resolvedFile)
            })

            console.info(printStats(stats))
        })
    }
    // Plugin
    // add the plugin at the end of middleware
    // when the first request comes in, start taking all the imports using the traverser
    // then use fileToRequestId to get the original importPath and create the entryPoints map
    // create the bundles and save them in root/web_modules
    // add the aliases to the resolver to point to the created web_modules files
}

function getPackageNameFromImportPath(importPath: string) {
    const parts = importPath.replace(moduleRE, '').split('/')
    if (parts[0].startsWith('@')) {
        return parts.slice(0, 2).join('/')
    }
    return parts[0]
}

async function getDepHash(root: string) {
    const lockfileLoc = await findUp(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'], {
        cwd: root,
    })
    if (!lockfileLoc) {
        return
    }
    const content = await (await fsp.readFile(lockfileLoc, 'utf-8')).toString()
    return createHash('sha1').update(content).digest('base64').trim()
}

async function updateHash(hashPath: string, newHash: string) {
    console.log({hashPath})
    await fsx.createFile(hashPath)
    await fsx.writeFile(hashPath, newHash.trim())
}

const queryRE = /\?.*$/
const hashRE = /#.*$/

const cleanUrl = (url: string) => {
    return url.replace(hashRE, '').replace(queryRE, '')
}
