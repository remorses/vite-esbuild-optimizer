import { Plugin } from 'vite'
import { esbuildOptimizerServerPlugin } from './optimizer'

export function esbuildOptimizerPlugin(args: {
    force?: boolean
    entryPoints: string[]
}): Plugin {
    return {
        configureServer: esbuildOptimizerServerPlugin(args),
    }
}
