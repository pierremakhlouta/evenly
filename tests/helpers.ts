import type { Summary } from '../src/api/types';
import type { AppContext } from '../src/ui/app';
import { GroupView } from '../src/ui/state';

/** An app context for UI tests: real view helpers, no-op actions. */
export function fakeContext(summary: Summary, root: HTMLElement): AppContext {
  return {
    root,
    view: new GroupView(summary),
    recent: [],
    refresh: () => Promise.resolve(),
    leave: () => undefined,
    switchPerson: () => undefined,
    openEntry: () => undefined,
  };
}
