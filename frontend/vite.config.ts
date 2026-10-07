import { readdirSync, readFileSync, renameSync, existsSync, mkdirSync, copyFileSync } from 'fs';
import { resolve } from 'path';
import { defineConfig } from 'vite';

const input: string[] = [];
for (const file of readdirSync(resolve(__dirname, 'src', 'pages'))) {
    if (file.endsWith('.html')) {
        input.push(resolve(__dirname, 'src', 'pages', file));
    }
}

const plugins = [
    {
        name: 'inject-partials',
        transformIndexHtml(html: string): string {
            const { version } = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));
            const navbar = readFileSync(resolve(__dirname, 'src', 'partials', '_navbar.html'), 'utf-8').replace('<!-- APP_VERSION -->', version);
            html = html.replace('<!-- NAVBAR_PLACEHOLDER -->', navbar);

            // Runs before first render: the stored or system theme, so a dark page never flashes white
            const blockingScript =
                `<script>(()=>{try{` +
                `var t=localStorage.getItem('theme')||(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light');` +
                `document.documentElement.setAttribute('data-bs-theme',t);` +
                `}catch(e){}})()<\/script>`;

            return html.replace('<head>', '<head>' + blockingScript);
        },
    },
    {
        name: 'move-html-and-public',
        closeBundle: async () => {
            const distPath = resolve(__dirname, '..', 'backend', 'dist', 'frontend');

            // Move HTML files to the root, where the backend's page routes read them
            for (const file of readdirSync(resolve(__dirname, 'src', 'pages'))) {
                const legacyPath = resolve(distPath, 'src', 'pages', file);
                if (existsSync(legacyPath)) {
                    renameSync(legacyPath, resolve(distPath, file));
                }
            }

            // Copy public folder contents to dist root
            const copyDir = (src: string, dest: string) => {
                mkdirSync(dest, { recursive: true });
                for (const entry of readdirSync(src, { withFileTypes: true })) {
                    const srcPath = resolve(src, entry.name);
                    const destPath = resolve(dest, entry.name);
                    if (entry.isDirectory()) {
                        copyDir(srcPath, destPath);
                    } else {
                        copyFileSync(srcPath, destPath);
                    }
                }
            };
            copyDir(resolve(__dirname, 'public'), distPath);
        },
    },
];

export default defineConfig({
    plugins: plugins,
    build: {
        outDir: '../backend/dist/frontend',
        chunkSizeWarningLimit: 1300,
        rollupOptions: {
            input: input,
        },
    },
});
