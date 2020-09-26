// @flow

import type {
  Asset,
  BundleGraph,
  NamedBundle,
  PluginOptions,
} from '@parcel/types';
import type {
  ArrayExpression,
  ExpressionStatement,
  File,
  Statement,
} from '@babel/types';

import babelGenerate from '@babel/generator';
import invariant from 'assert';
import path from 'path';
import fs from 'fs';
import {needsPrelude} from './utils';
import SourceMap from '@parcel/source-map';
import * as t from '@babel/types';
import template from '@babel/template';
import {parse} from '@babel/parser';

const REGISTER_TEMPLATE = template.statements<{|
  REFERENCED_IDS: ArrayExpression,
  STATEMENTS: Array<Statement>,
|}>(`
function $parcel$bundleWrapper() {
  if ($parcel$bundleWrapper._executed) return;
  STATEMENTS;
  $parcel$bundleWrapper._executed = true;
}
var $parcel$referencedAssets = REFERENCED_IDS;
for (var $parcel$i = 0; $parcel$i < $parcel$referencedAssets.length; $parcel$i++) {
  parcelRequire.registerBundle($parcel$referencedAssets[$parcel$i], $parcel$bundleWrapper);
}
`);
const WRAPPER_TEMPLATE = template.statement<
  {|STATEMENTS: Array<Statement>|},
  ExpressionStatement,
>('(function () { STATEMENTS; })()');

const PRELUDE_PATH = path.join(__dirname, 'prelude.js');
const PRELUDE = parse(
  fs.readFileSync(path.join(__dirname, 'prelude.js'), 'utf8'),
  {sourceFilename: PRELUDE_PATH},
);

function isEntry(
  bundle: NamedBundle,
  bundleGraph: BundleGraph<NamedBundle>,
): boolean {
  return (
    !bundleGraph.hasParentBundleOfType(bundle, 'js') ||
    bundle.env.isIsolated() ||
    !!bundle.getMainEntry()?.isIsolated
  );
}

export function generate({
  bundleGraph,
  bundle,
  ast,
  referencedAssets,
  options,
}: {|
  bundleGraph: BundleGraph<NamedBundle>,
  bundle: NamedBundle,
  ast: File,
  options: PluginOptions,
  referencedAssets: Set<Asset>,
|}): {|contents: string, map: ?SourceMap|} {
  let interpreter;
  let mainEntry = bundle.getMainEntry();
  if (mainEntry && !bundle.target.env.isBrowser()) {
    let _interpreter = mainEntry.meta.interpreter;
    invariant(_interpreter == null || typeof _interpreter === 'string');
    interpreter = _interpreter;
  }

  let isAsync = !isEntry(bundle, bundleGraph);

  let statements = ast.program.body;
  if (bundle.env.outputFormat === 'global') {
    // Wrap async bundles in a closure and register with parcelRequire so they are executed
    // at the right time (after other bundle dependencies are loaded).
    if (isAsync) {
      statements = REGISTER_TEMPLATE({
        STATEMENTS: statements,
        REFERENCED_IDS: t.arrayExpression(
          [mainEntry, ...referencedAssets]
            .filter(Boolean)
            .map(asset => t.stringLiteral(bundleGraph.getAssetPublicId(asset))),
        ),
      });
    }

    if (needsPrelude(bundle, bundleGraph)) {
      statements.unshift(...PRELUDE.program.body);
    }

    statements = [WRAPPER_TEMPLATE({STATEMENTS: statements})];
  }

  ast = t.file(
    t.program(
      statements,
      [],
      bundle.env.outputFormat === 'esmodule' ? 'module' : 'script',
      interpreter ? t.interpreterDirective(interpreter) : null,
    ),
  );

  let {code, rawMappings} = babelGenerate(ast, {
    sourceMaps: options.sourceMaps,
    minified: bundle.env.minify,
    comments: true, // retain /*@__PURE__*/ comments for terser
  });

  let map = null;
  if (options.sourceMaps && rawMappings != null) {
    map = new SourceMap(options.projectRoot);
    map.addIndexedMappings(rawMappings);
  }

  return {
    contents: code,
    map,
  };
}
