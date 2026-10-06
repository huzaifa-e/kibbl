import { defineConfig } from 'tsup';

export default defineConfig({
    // the server, and the command that links a user to Google Health with an existing token
    entry: { app: './src/app.ts', 'health-import': './src/healthImport.ts' },
    sourcemap: false,
    bundle: true,
    platform: 'node',
    target: 'node20',
    outDir: 'dist',
    // sharp loads a native binary of its own platform, it is installed next to the bundle
    noExternal: [/^(?!.*(sharp|bufferutil))/],
    external: ['sharp', 'bufferutil'],
});
