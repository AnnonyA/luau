# Luau Testing

Experimental open-source Luau bytecode decompiler and analysis playground.

The project is under active development. Correctness and explicit diagnostics take priority over producing plausible-looking source when the input cannot be reconstructed safely.

## Current pipeline

`bytecode -> decode -> CFG -> SSA -> structured AST -> simplification -> Luau printer`

The repository currently includes:

- Luau bytecode decoding and version/profile handling
- control-flow graph construction
- SSA/data-flow analysis
- structural reconstruction and AST simplification
- name recovery helpers
- Luau source printing
- a small browser UI for inspecting decompilation results
- a controlled bytecode fixture encoder for regression testing

## Development status

This is **testing software**, not a stable production decompiler yet. Bytecode compatibility and reconstruction quality are expanded incrementally and should only be claimed when backed by reproducible fixtures and tests.

Input bytecode is treated as untrusted data and must not be executed by the decompiler.

## Development

```bash
npm install
npm run dev
```

Build:

```bash
npm run build
```

## License

MIT. See [LICENSE](LICENSE).
