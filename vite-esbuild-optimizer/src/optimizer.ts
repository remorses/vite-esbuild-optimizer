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
const hashPath = '.optimizer-hash'

export function esbuildOptimizerPlugin({
    entryPoints,
    link = [],
    force = false,
}): ServerPlugin {
    // maps /@modules/module/index.js to /web_modules/module/index.js
    const webModulesResolutions = new Map<string, string>()

    const linkedPackages = new Set(link)

    let alreadyProcessed = false
    return ({ app, root, watcher, config, resolver }) => {
        const dest = path.join(root, 'web_modules')

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
                    console.info(
                        'Hash is consistent. Skipping optimization.',
                    )
                    alreadyProcessed = true
                    return
                }
            }
            await updateHash(root, depHash)

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
                ...traversalResult // test that es module traversal removes queries from importPaths
                    .filter(
                        (x) =>
                            moduleRE.test(x.importPath) &&
                            !isLinkedImportPath(x.importPath),
                    )
                    .map((x) => {
                        const k = x.importPath //.replace(moduleRE, '')

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
                        const importPath = x.importPath.replace(moduleRE, '')
                        console.log({ importerDir })
                        const file = defaultResolver(importerDir, importPath)
                        return {
                            [k]: file,
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
    const lockfileLoc = await findUp(['package-lock.json', 'yarn.lock'], {
        cwd: root,
    })
    if (!lockfileLoc) {
        return
    }
    const content = await (await fsp.readFile(lockfileLoc, 'utf-8')).toString()
    return createHash('sha1').update(content).digest('base64')
}

async function updateHash(root: string, newHash: string) {
    const loc = path.join(root, hashPath)
    await fsx.createFile(loc)
    await fsx.writeFile(loc, newHash.trim())
}
