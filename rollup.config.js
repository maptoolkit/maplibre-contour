import fs from "fs";
import typescript from "@rollup/plugin-typescript";
import terser from "@rollup/plugin-terser";
import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";

export const nodeResolve = resolve({
  browser: true,
  preferBuiltins: false,
});

const create = (file, format, plugins = []) => ({
  input: "build/mlcontour.js",
  output: {
    name: "mlcontour",
    file,
    format,
    intro: fs.readFileSync("build/bundle_prelude.js", "utf8"),
  },
  treeshake: false,
  plugins,
});

/** @type {import('rollup').RollupOptions[]} */
export default [
  {
    input: ["src/index.ts", "src/worker.ts"],
    output: {
      dir: "dist/staging",
      format: "amd",
      indent: false,
      chunkFileNames: "shared.js",
      minifyInternalExports: true,
    },
    onwarn: (message) => {
      // Ignore circular dependency warnings from third-party dependencies
      if (message.code === 'CIRCULAR_DEPENDENCY' && message.ids?.some(id => id.includes('node_modules'))) {
        return;
      }
      console.error(message);
      throw message;
    },
    treeshake: true,
    plugins: [
      nodeResolve, 
      typescript({
        exclude: ["**/*.test.ts", "**/*.spec.ts"]
      }), 
      commonjs()
    ],
  },
  create("dist/index.cjs", "cjs"),
  create("dist/index.mjs", "esm"),
  create("dist/index.js", "umd"),
  create("dist/index.min.js", "umd", [terser()]),
];
