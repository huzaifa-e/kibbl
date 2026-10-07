import { defineConfig } from 'tsup';

export default defineConfig({
    // the server, the command that links a user to Google Health with an existing token,
    // and the one that creates and revokes tokens for the MCP endpoint
    entry: { app: './src/app.ts', 'health-import': './src/healthImport.ts', 'mcp-token': './src/mcpToken.ts' },
    sourcemap: false,
    bundle: true,
    platform: 'node',
    target: 'node20',
    outDir: 'dist',
    // sharp loads a native binary of its own platform, it is installed next to the bundle
    noExternal: [/^(?!.*(sharp|bufferutil))/],
    external: ['sharp', 'bufferutil'],
});
