import type { ServerPlugin, UserConfig } from 'vite'
import { esbuildOptimizerPlugin } from 'vite-esbuild-optimizer'

module.exports = {
    jsx: 'react',
    optimizeDeps: {
        auto: false,
        // link: ['package-b', 'some-react-components'],
    },
    plugins: [
        esbuildOptimizerPlugin({
            entryPoints: ['/main.tsx'],
            // link: ['example-linked-package'],
            force: true,
        }),
    ],
    configureServer: [virtualHtmlPlugin({ entryPoint: '/main.tsx' })],
} as UserConfig

function virtualHtmlPlugin({ entryPoint }) {
    return ({ app }) =>
        app.use(async (ctx, next) => {
            // wait for vite history fallback
            // this redirects all valid paths to `index.html`
            await next()
            if (ctx.url === '/index.html') {
                ctx.body = `
                <!DOCTYPE html>
                <html lang="en">
                <head>
                <meta charset="UTF-8">
                <title>Vite App</title>
                </head>
                <body>
                <div id="root"></div>
                <script type="module" src="${entryPoint}"></script>
                </body>
                </html>
                `
                ctx.status = 200
            }
        })
}
