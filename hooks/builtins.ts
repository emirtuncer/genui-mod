import type { GenuiTemplate } from '../types'

const tests: GenuiTemplate = {
  title: 'Test status',
  description: 'vitest results (for jest, set argv to ["npx", "--no", "jest", "--json"])',
  sources: { r: { argv: ['npx', '--no', 'vitest', 'run', '--reporter=json'], parse: 'json', timeoutMs: 300_000, allowFailure: true } },
  refreshSeconds: 0,
  tree: {
    type: 'box',
    gap: 1,
    children: [
      {
        type: 'box',
        direction: 'row',
        gap: 3,
        children: [
          { type: 'text', text: '✓ {{r.numPassedTests}} passed', color: 'success', bold: true },
          { type: 'text', text: '✗ {{r.numFailedTests}} failed', color: 'error', bold: true },
          { type: 'text', text: '○ {{r.numPendingTests}} skipped', dim: true },
        ],
      },
      { type: 'progress', value: '{{r.numPassedTests}}', max: '{{r.numTotalTests}}', label: 'Passing' },
      {
        type: 'when',
        test: '{{r.testResults | where:status=failed}}',
        node: {
          type: 'box',
          border: true,
          title: 'Failing',
          children: [
            {
              type: 'each',
              items: '{{r.testResults | where:status=failed}}',
              as: 'file',
              node: {
                type: 'box',
                children: [
                  { type: 'text', text: '{{file.name}}', bold: true },
                  {
                    type: 'each',
                    items: '{{file.assertionResults | where:status=failed}}',
                    as: 't',
                    node: { type: 'text', text: '  ✗ {{t.fullName}}', color: 'error' },
                  },
                  { type: 'when', test: '{{file.message}}', node: { type: 'text', text: '  {{file.message}}', color: 'error', dim: true } },
                ],
              },
            },
          ],
        },
        else: { type: 'text', text: 'All tests pass.', color: 'success' },
      },
      {
        type: 'box',
        direction: 'row',
        gap: 2,
        children: [
          { type: 'button', id: 'rerun', label: 'Run again', action: 'refresh' },
          {
            type: 'when',
            test: '{{r.testResults | where:status=failed}}',
            node: {
              type: 'button',
              id: 'fix',
              label: 'Ask Claude to fix',
              action: 'prompt',
              prompt: 'These test files fail; find the cause and fix them:\n{{r.testResults | where:status=failed | map:name | join:\\n}}',
            },
          },
        ],
      },
    ],
  },
}

const git: GenuiTemplate = {
  title: 'Git status',
  sources: {
    branch: { argv: ['git', 'branch', '--show-current'], parse: 'text' },
    sync: { argv: ['git', 'rev-list', '--left-right', '--count', '@{u}...HEAD'], parse: 'text', allowFailure: true },
    changes: { argv: ['git', 'status', '--porcelain'], parse: 'lines' },
    staged: { argv: ['git', 'diff', '--cached', '--name-status', '--no-renames'], parse: 'lines' },
    modified: { argv: ['git', 'diff', '--name-only', '--diff-filter=M'], parse: 'lines' },
    deleted: { argv: ['git', 'diff', '--name-only', '--diff-filter=D'], parse: 'lines' },
    untracked: { argv: ['git', 'ls-files', '--others', '--exclude-standard', '--directory'], parse: 'lines' },
    log: { argv: ['git', 'log', '-8', '--format=%h%x09%s%x09%cr'], parse: 'lines', allowFailure: true },
  },
  refreshSeconds: 10,
  tree: {
    type: 'box',
    gap: 1,
    children: [
      {
        type: 'box',
        direction: 'row',
        gap: 2,
        children: [
          { type: 'text', text: '⎇ {{branch | default:—}}', bold: true, color: 'claude' },
          { type: 'text', text: '↓ {{sync | split:\\t | first | default:—}} behind', color: 'warning' },
          { type: 'text', text: '↑ {{sync | split:\\t | last | default:—}} ahead', color: 'success' },
        ],
      },
      {
        type: 'box',
        direction: 'row',
        gap: 2,
        children: [
          { type: 'text', text: '● {{staged | length}} staged', color: 'suggestion' },
          { type: 'text', text: '● {{modified | length}} modified', color: 'warning' },
          { type: 'text', text: '● {{deleted | length}} deleted', color: 'error' },
          { type: 'text', text: '● {{untracked | length}} untracked', color: 'success' },
        ],
      },
      {
        type: 'when',
        test: '{{changes}}',
        node: {
          type: 'box',
          border: true,
          title: 'Changes',
          children: [
            {
              type: 'each',
              items: '{{staged | take:30}}',
              as: 's',
              node: { type: 'box', direction: 'row', gap: 1, children: [{ type: 'text', text: '{{s | split:\\t | first}}', bold: true, color: 'suggestion' }, { type: 'text', text: '{{s | split:\\t | last}}', color: 'suggestion' }] },
            },
            {
              type: 'each',
              items: '{{modified | take:30}}',
              as: 'm',
              node: { type: 'box', direction: 'row', gap: 1, children: [{ type: 'text', text: 'M', bold: true, color: 'warning' }, { type: 'text', text: '{{m}}' }] },
            },
            {
              type: 'each',
              items: '{{deleted | take:30}}',
              as: 'd',
              node: { type: 'box', direction: 'row', gap: 1, children: [{ type: 'text', text: 'D', bold: true, color: 'error' }, { type: 'text', text: '{{d}}', dim: true }] },
            },
            {
              type: 'each',
              items: '{{untracked | take:30}}',
              as: 'u',
              node: { type: 'box', direction: 'row', gap: 1, children: [{ type: 'text', text: 'U', bold: true, color: 'success' }, { type: 'text', text: '{{u}}' }] },
            },
          ],
        },
        else: { type: 'text', text: '✓ Working tree clean.', color: 'success' },
      },
      {
        type: 'box',
        border: true,
        title: 'Recent commits',
        children: [
          {
            type: 'when',
            test: '{{log}}',
            node: {
              type: 'each',
              items: '{{log}}',
              as: 'l',
              node: {
                type: 'box',
                direction: 'row',
                gap: 1,
                children: [
                  { type: 'text', text: '{{l | split:\\t | first}}', color: 'warning' },
                  { type: 'text', text: '{{l | split:\\t | take:2 | last}}' },
                  { type: 'text', text: '({{l | split:\\t | last}})', dim: true },
                ],
              },
            },
            else: { type: 'text', text: 'No commits yet.', dim: true },
          },
        ],
      },
      { type: 'button', id: 'refresh', label: 'Refresh', action: 'refresh' },
    ],
  },
}

const pods: GenuiTemplate = {
  title: 'Kubernetes pods',
  sources: { pods: { argv: ['kubectl', 'get', 'pods', '-A', '-o', 'json'], parse: 'json', timeoutMs: 20_000 } },
  refreshSeconds: 10,
  tree: {
    type: 'box',
    gap: 1,
    children: [
      {
        type: 'kv',
        items: [
          { key: 'Pods', value: '{{pods.items | length}}' },
          { key: 'Running', value: '{{pods.items | count:status.phase=Running}}' },
          { key: 'Not running', value: '{{pods.items | where:status.phase!=Running | where:status.phase!=Succeeded | length}}' },
        ],
      },
      {
        type: 'when',
        test: '{{pods.items | where:status.phase!=Running | where:status.phase!=Succeeded}}',
        node: {
          type: 'box',
          border: true,
          title: 'Needs attention',
          children: [
            {
              type: 'each',
              items: '{{pods.items | where:status.phase!=Running | where:status.phase!=Succeeded}}',
              as: 'p',
              node: { type: 'text', text: '{{p.metadata.namespace}}/{{p.metadata.name}}: {{p.status.phase}}', color: 'warning' },
            },
          ],
        },
      },
      {
        type: 'table',
        columns: ['Namespace', 'Pod', 'Phase', 'Restarts'],
        rows: [
          {
            type: 'each',
            items: '{{pods.items | sort:metadata.namespace}}',
            as: 'p',
            node: ['{{p.metadata.namespace}}', '{{p.metadata.name}}', '{{p.status.phase}}', '{{p.status.containerStatuses[0].restartCount | default:0}}'],
          },
        ],
      },
      { type: 'button', id: 'refresh', label: 'Refresh', action: 'refresh' },
    ],
  },
}

export const BUILTINS: Record<string, GenuiTemplate> = { tests, git, pods }
