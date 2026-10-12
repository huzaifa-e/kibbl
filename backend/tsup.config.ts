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
    // sharp and onnxruntime-node load a native binary of their own platform, they are installed next to the bundle
    noExternal: [/^(?!.*(sharp|bufferutil|onnxruntime-node))/],
    external: ['sharp', 'bufferutil', 'onnxruntime-node'],
});
