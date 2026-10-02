import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['./src/app.ts'],
    sourcemap: false,
    bundle: true,
    platform: 'node',
    target: 'node20',
    outDir: 'dist',
    // sharp loads a native binary of its own platform, it is installed next to the bundle
    noExternal: [/^(?!.*(sharp|bufferutil))/],
    external: ['sharp', 'bufferutil'],
});
