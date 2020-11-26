import builtins from 'builtin-modules'
import { Plugin } from 'esbuild'

// resolve node builtins

// mark node modules as external

export function StopTraversingPlugin({ stopTraversing }): Plugin {
    return {
        name: 'stop-traversing',
        setup: function setup({ onLoad, onResolve }) {
            onResolve({ filter: /.*/ }, (args) => {
                console.log({ args })
                // args.path
                const external = stopTraversing(
                    args.resolveDir, // TODO replace resolveDir with the complete path to file
                    args.importer,
                )
                return {
                    external,
                }
            })
        },
    }
}

export function CustomResolverPlugin({ resolver }): Plugin {
    const builtinsSet = new Set(builtins)
    return {
        name: 'custom-resolver',
        setup: function setup({ onLoad, onResolve }) {
            onLoad({ filter: /.*/, namespace: 'builtins' }, (args) => {
                console.info('mocking ' + args.path)
                return {
                    loader: 'js',
                    contents: 'module.exports = {}',
                }
            })
            onResolve({ filter: /.*/ }, (args) => {
                if (builtinsSet.has(args.path)) {
                    return {
                        namespace: 'builtins',
                        path: args.path,
                    }
                }
                if (args.path.startsWith('.') || args.path.startsWith('/')) {
                    return null
                }
                // console.log(args.importer, args.path)
                const resolved = resolver(args.importer, args.path)

                // console.log({ resolved })
                if (!resolved) {
                    return {
                        external: true,
                    }
                }
                return {
                    path: resolved,
                }
            })
        },
    }
}
