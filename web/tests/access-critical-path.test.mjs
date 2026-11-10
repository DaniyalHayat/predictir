import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('private access route excludes workspace styles and controls from its shared layout',async()=>{
  const root=await readFile(new URL('../app/layout.tsx',import.meta.url),'utf8');
  const workspace=await readFile(new URL('../app/(workspace)/layout.tsx',import.meta.url),'utf8');
  const access=await readFile(new URL('../app/access/Access.tsx',import.meta.url),'utf8');
  assert.doesNotMatch(root,/Analytics|PrivateWorkspaceControls|workspace\.css|\.css['"]/);
  assert.match(workspace,/PrivateWorkspaceControls/);
  assert.match(workspace,/Analytics/);
  assert.doesNotMatch(access,/\.css['"]/);
});

test('chart vendor CSS remains in the on-demand chart chunk rather than the main workspace module',async()=>{
  const app=await readFile(new URL('../ui/App.jsx',import.meta.url),'utf8');
  const chart=await readFile(new URL('../ui/Chart.tsx',import.meta.url),'utf8');
  assert.match(app,/dynamic\(\(\)=>import\('\.\/Chart'\)/);
  assert.doesNotMatch(app,/import ['"]uplot\/dist\/uPlot\.min\.css/);
  assert.match(chart,/uplot\/dist\/uPlot\.min\.css/);
});
