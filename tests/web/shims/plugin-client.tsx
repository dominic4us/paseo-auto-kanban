// The host's `@getpaseo/plugin/client` for the headless page: RPCs answered by the fake server in page.tsx, and a
// Paseo SDK that lists the fixture's projects and workspaces and no agents.
declare global { interface Window { __rpc: (name: string, input: unknown) => Promise<unknown>; __sdk: unknown } }
// 317-F1: the workflow reply passes the reply schema as the installed SDK's `callPluginRpc` checks it (`contract.output.parseAsync`),
// so a reply the host would refuse is refused here too — not shown as if it had arrived.
export const useRpc = (contract: { name: string; output?: { parseAsync: (value: unknown) => Promise<unknown> } }) => (input: unknown) =>
  contract.name === 'kanban.v1.workflow.get' && contract.output
    ? Promise.resolve(window.__rpc(contract.name, input)).then(output => contract.output!.parseAsync(output)) : window.__rpc(contract.name, input);
export const usePaseo = () => window.__sdk;
export const useWorkspace = () => { throw new Error('No workspace panel in the headless page.'); };
export type PluginSurfaceProps = never; export type PluginClientContext = never; export type PluginWorkspacePanelProps = never;
