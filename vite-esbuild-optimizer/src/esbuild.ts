import { build as esbuild, Metadata } from 'esbuild'
import fs from 'fs'
import { invert } from 'lodash/fp'
import path from 'path'
import toUnixPath from 'slash'
import tmpfile from 'tmpfile'
import { DependencyStatsOutput } from './stats'

export async function bundleWithEsBuild({
    entryPoints,
    dest: destLoc,
    ...options
}) {
    const {
        env = {},
        alias = {},
        externalPackages = [],
        minify = false,
    } = options

    const metafile = path.join(destLoc, './meta.json')
    // const entryPoints = [...Object.values(installEntrypoints)]

    const tsconfigTempFile = tmpfile('.json')
    await fs.promises.writeFile(tsconfigTempFile, makeTsConfig({ alias }))

    // rimraf.sync(destLoc) // do not delete or on flight imports will return 404
    await esbuild({
        splitting: true, // needed to dedupe modules
        external: externalPackages,
        minifyIdentifiers: Boolean(minify),
        minifySyntax: Boolean(minify),
        minifyWhitespace: Boolean(minify),
        mainFields: ['browser:module', 'module', 'browser', 'main'].filter(
            Boolean,
        ),
        // sourcemap: 'inline', // TODO sourcemaps panics and gives a lot of CPU load
        define: {
            'process.env.NODE_ENV': JSON.stringify('dev'),
            global: 'window',
            ...generateEnvReplacements(env),
        },
        // TODO inject polyfills for runtime globals like process, ...etc
        // TODO allow importing from node builtins when using allowNodeImports
        // TODO add plugin for pnp resolution
        tsconfig: tsconfigTempFile,
        bundle: true,
        format: 'esm',
        write: true,
        entryPoints,
        outdir: destLoc,
        minify: Boolean(minify),
        logLevel: 'info',
        metafile,
    })

    await fs.promises.unlink(tsconfigTempFile)

    const meta = JSON.parse(
        await (await fs.promises.readFile(metafile)).toString(),
    )

    const importMap = metafileToImportMap({
        entryPoints,
        meta,
        destLoc: destLoc,
    })

    const stats = metafileToStats({ meta, destLoc })

    return { stats, importMap }
}

function makeTsConfig({ alias }) {
    const aliases = Object.keys(alias || {}).map((k) => {
        return {
            [k]: [alias[k]],
        }
    })
    const tsconfig = {
        compilerOptions: { baseUrl: '.', paths: Object.assign({}, ...aliases) },
    }

    return JSON.stringify(tsconfig)
}

function metafileToImportMap(_options: {
    entryPoints: string[]
    meta: Metadata
    destLoc: string
}): Record<string, string> {
    const { destLoc: destLoc, entryPoints, meta } = _options
    const inputFiles = entryPoints.map((x) => path.resolve(x)) // TODO replace resolve with join in cwd

    const importMaps: Record<string, string>[] = Object.keys(meta.outputs).map(
        (output) => {
            // chunks cannot be entrypoints
            if (path.basename(output).startsWith('chunk.')) {
                return {}
            }
            const inputs = Object.keys(meta.outputs[output].inputs).map((x) =>
                path.resolve(x),
            ) // TODO will this resolve work with pnp?
            const input = inputs.find((x) => inputFiles.includes(x))
            if (!input) {
                return {}
            }
            // const specifier = inputFilesToSpecifiers[input]
            return {
                [input]:
                    './' +
                    toUnixPath(path.normalize(path.relative(destLoc, output))),
            }
        },
    )
    const importMap = Object.assign({}, ...importMaps)
    return importMap
}

function metafileToStats(_options: {
    meta: Metadata
    destLoc: string
}): DependencyStatsOutput {
    const { meta, destLoc } = _options
    const stats = Object.keys(meta.outputs).map((output) => {
        const value = meta.outputs[output]
        // const inputs = meta.outputs[output].bytes;
        return {
            path: output,
            isCommon: ['chunk.'].some((x) =>
                path.basename(output).startsWith(x),
            ),
            bytes: value.bytes,
        }
    })

    function makeStatObject(value) {
        const relativePath = toUnixPath(path.relative(destLoc, value.path))
        return {
            [relativePath]: {
                size: value.bytes,
                // gzip: zlib.gzipSync(contents).byteLength,
                // brotli: zlib.brotliCompressSync ? zlib.brotliCompressSync(contents).byteLength : 0,
            },
        }
    }

    return {
        common: Object.assign(
            {},
            ...stats.filter((x) => x.isCommon).map(makeStatObject),
        ),
        direct: Object.assign(
            {},
            ...stats.filter((x) => !x.isCommon).map(makeStatObject),
        ),
    }
}

function generateEnvReplacements(env: Object): { [key: string]: string } {
    return Object.keys(env).reduce((acc, key) => {
        acc[`process.env.${key}`] = JSON.stringify(env[key])
        return acc
    }, {})
}
