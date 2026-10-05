// One stable home for each destination. Prefixes include its detail routes;
// related standalone readers and approval pages explicitly share that home.
export const NAVIGATION_GROUPS = [
  { key: 'system', label: 'System', items: [
    { to: '/systems', label: 'Systems', test: 'nav-systems' },
    { to: '/racks', label: 'Racks' },
    { to: '/modules', label: 'Modules' },
    { to: '/import', label: 'Import modules' },
  ] },
  { key: 'music', label: 'Music', items: [
    { to: '/patches', label: 'Patches' },
    { to: '/compositions', label: 'Compositions', test: 'nav-compositions' },
    { to: '/performances', label: 'Performances', test: 'nav-performances' },
  ] },
  { key: 'knowledge', label: 'Knowledge', items: [
    { to: '/search', label: 'Search manuals', test: 'nav-search', related: ['/manuals'] },
    { to: '/notes', label: 'Notes' },
    { to: '/ask', label: 'Ask a question' },
    { to: '/questions', label: 'Questions' },
    { to: '/shared', label: 'Shared items', test: 'nav-shared' },
  ] },
  { key: 'tools', label: 'Tools', items: [
    { to: '/devices', label: 'Devices', test: 'nav-devices', related: ['/link'] },
    { to: '/jobs', label: 'Jobs' },
  ] },
  { key: 'account', label: 'Account', items: [
    { to: '/account/email', label: 'Email address', test: 'nav-email', related: ['/verify-email'] },
    { to: '/account/password', label: 'Change password', test: 'account' },
    { to: '/account/llm', label: 'LLM account', test: 'nav-llm' },
    { to: '/account/voice', label: 'Patch by voice', test: 'nav-voice' },
  ] },
  { key: 'admin', label: 'Administration', admin: true, items: [
    { to: '/admin/users', label: 'Users' },
    { to: '/admin/config', label: 'Application Config' },
    { to: '/admin/mail', label: 'Mail server', test: 'nav-mail' },
    { to: '/admin/csp-reports', label: 'Policy violations', test: 'nav-csp-reports' },
  ] },
];

export function findDestination(path) {
  return NAVIGATION_GROUPS.flatMap((group) => group.items).find((item) =>
    [item.to, ...(item.related || [])].some((prefix) => path === prefix || path?.startsWith(`${prefix}/`))
  );
}
