import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { useOverviewScroll } from '../dist/client/overview-scroll.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

async function fixture(t, memory = { position: { y: 630 } }, ready = true) {
  const previousRAF = globalThis.requestAnimationFrame, previousCancel = globalThis.cancelAnimationFrame;
  const jobs = new Map(), canceled = [], restores = [];
  let next = 1, hook, root;
  globalThis.requestAnimationFrame = callback => { const id = next++; jobs.set(id, callback); return id; };
  globalThis.cancelAnimationFrame = id => { const callback = jobs.get(id); if (callback) { canceled.push(callback); jobs.delete(id); } };
  const node = { isConnected: true, scrollTop: 0, scrollHeight: 2400, clientHeight: 400,
    getBoundingClientRect: () => ({ top: 0, bottom: 400 }) };
  const scroll = { current: { getScrollableNode: () => node, scrollTo: ({ y }) => { restores.push(y); node.scrollTop = y; } } };
  function Screen(props) { hook = useOverviewScroll(props.memory, scroll, props.ready); return null; }
  const render = async (nextMemory = memory, nextReady = true) => {
    await act(async () => { const element = React.createElement(Screen, { memory: nextMemory, ready: nextReady });
      if (root) root.update(element); else root = create(element); });
  };
  const flush = async () => { const callbacks = [...jobs.values()]; jobs.clear(); await act(async () => { for (const callback of callbacks) callback(0); }); };
  const settle = async () => { for (let frame = 0; frame < 10 && jobs.size; frame++) await flush(); assert.equal(jobs.size, 0); };
  const unmount = async () => { if (root) { await act(async () => root.unmount()); root = null; } };
  t.after(async () => { await unmount(); globalThis.requestAnimationFrame = previousRAF; globalThis.cancelAnimationFrame = previousCancel; });
  await render(memory, ready);
  return { node, scroll, memory, restores, canceled, jobs, hook: () => hook, render, flush, settle, unmount };
}

test('scroll restoration ignores the RN Web scroll-end event delivered after unmount', async t => {
  const f = await fixture(t); await f.settle();
  assert.equal(f.node.scrollTop, 630);
  const lateScrollEnd = f.hook().remember;
  await f.unmount(); f.scroll.current = null; f.node.isConnected = false; f.node.scrollTop = 0;
  lateScrollEnd(0);
  assert.equal(f.memory.position.y, 630, 'a detached view cannot erase the remembered layout');
});

test('only the latest scheduled restoration generation may apply after layout changes', async t => {
  const f = await fixture(t);
  f.hook().onLayout(); f.hook().onContentSizeChange();
  assert.ok(f.canceled.length > 0);
  await act(async () => { for (const callback of f.canceled) callback(0); });
  assert.deepEqual(f.restores, [], 'callbacks canceled by a newer measurement remain inert');
  await f.settle();
  assert.deepEqual(f.restores, [630], 'the final measured layout restores exactly once');
});

test('pending or stale scroll values never replace a saved position', async t => {
  const f = await fixture(t, { position: { y: 630 } }, false);
  f.hook().remember(0);
  assert.equal(f.memory.position.y, 630);
  await f.render(f.memory, true); await f.settle();
  f.hook().remember(0); // A stale event belongs to a replaced DOM node, whose live successor is at 630.
  assert.equal(f.memory.position.y, 630);
  f.node.scrollTop = 720; f.hook().remember(720);
  assert.equal(f.memory.position.y, 720, 'real scrolling after restoration is still recorded');
});

test('a previous screen-memory owner cannot write after a host/demo memory switch', async t => {
  const first = { position: { y: 630 } }, second = { position: { y: 345 } };
  const f = await fixture(t, first); await f.settle();
  const previousOwner = f.hook().remember;
  f.node.scrollTop = 0;
  await f.render(second); await f.settle();
  assert.equal(f.node.scrollTop, 345);
  previousOwner(345);
  assert.equal(first.position.y, 630, 'old owner callbacks cannot mutate their former memory');
  assert.equal(second.position.y, 345);
});

test('an asynchronous scrollTo acknowledgement cannot save the pre-restore zero', async t => {
  const f = await fixture(t);
  f.scroll.current.scrollTo = ({ y }) => f.restores.push(y); // Host has accepted the request, but not applied it yet.
  await f.settle();
  assert.deepEqual(f.restores, [630]);
  f.hook().remember(0);
  assert.equal(f.memory.position.y, 630, 'zero from the not-yet-restored view is ignored');
  f.node.scrollTop = 630; f.hook().remember(630);
  f.node.scrollTop = 720; f.hook().remember(720);
  assert.equal(f.memory.position.y, 720, 'normal user scrolling resumes after the acknowledgement');
});

test('an already-queued callback cannot restore a layout that was unmounted before its first frame', async t => {
  const f = await fixture(t);
  await f.unmount();
  assert.ok(f.canceled.length > 0);
  await act(async () => { for (const callback of f.canceled) callback(0); });
  assert.deepEqual(f.restores, []);
  assert.equal(f.memory.position.y, 630);
});

test('a hidden live view cannot replace its saved position with a transient zero', async t => {
  const f = await fixture(t); await f.settle();
  f.node.clientHeight = 0; f.node.scrollTop = 0; f.hook().remember(0);
  assert.equal(f.memory.position.y, 630);
});
