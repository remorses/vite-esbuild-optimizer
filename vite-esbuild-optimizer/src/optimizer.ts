import {
    defaultResolver,
    makeServerFunctions,
    traverseEsModules,
} from 'es-module-traversal'
import path from 'path'
import url from 'url'
import type { ServerPlugin, UserConfig } from 'vite'
import { bundleWithEsBuild } from './esbuild'
import { printStats } from './stats'

const moduleRE = /^\/@modules\//

export function esbuildOptimizerPlugin({
    entryPoints,
    link = [],
}): ServerPlugin {
    // maps /@modules/module/index.js to /web_modules/module/index.js
    const webModulesResolutions = new Map<string, string>()

    const linkedPackages = new Set(link)
    // TODO store an hash of lockfiles and last built dependencies to not optimize every time
    let alreadyProcessed = false
    return ({ app, root, watcher, resolver }) => {
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
            console.info('Optimizing dependencies')

            alreadyProcessed = true

            const port = ctx.port

            const isUserImportPath = (importPath: string) => {
                return linkedPackages.has(
                    importPath.replace(moduleRE, '').split('/')[0],
                )
            } // TODO continue traversing in linked deps, check if vite can always serve linked deps

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
                        !isUserImportPath(importPath)
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
                            !isUserImportPath(x.importPath),
                    ) // TODO remove linked deps? linked deps should be already optimized?
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
