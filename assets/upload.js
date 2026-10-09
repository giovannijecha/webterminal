// Dropped files are staged by the server for the controlling view, then
// pasted as quoted local paths, the way native terminals deliver a drop.
export const FILE_LIMIT = 1024 ** 3;
export const DROP_LIMIT = 64;

// Read synchronously inside the drop event; folders are skipped.
export function droppedFiles(transfer) {
  const items = [...(transfer?.items || [])].filter(item => item.kind === 'file');
  if (!items.length) return [...(transfer?.files || [])];
  return items.filter(item => !item.webkitGetAsEntry?.()?.isDirectory).map(item => item.getAsFile()).filter(Boolean);
}

function shellName(shell) {
  const command = shell.trim().match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  return (command?.[1] || command?.[2] || command?.[3] || '').split(/[\\/]/).pop().toLowerCase();
}

function isCmd(shell) { return ['cmd', 'cmd.exe'].includes(shellName(shell)); }
const cmdExpansionProblem = 'cmd.exe expands % and may expand ! in paths; rename the file or use PowerShell before dropping it.';
const cmdExpansion = path => /[%!]/.test(path);

export function pathList(paths, shell = 'powershell.exe') {
  const executable = shellName(shell);
  if (isCmd(shell) && paths.some(cmdExpansion)) throw new Error(cmdExpansionProblem);
  const powerShell = ['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'].includes(executable);
  return paths.map(path => powerShell ? `'${path.replaceAll("'", "''")}'` : `"${path}"`).join(' ');
}

export function dropProblem(files, shell = 'powershell.exe') {
  if (files.length > DROP_LIMIT) return `Drop at most ${DROP_LIMIT} files at once.`;
  const large = files.find(file => file.size > FILE_LIMIT);
  if (large) return `${large.name} is larger than 1 GiB.`;
  return isCmd(shell) && files.some(file => cmdExpansion(file.name)) ? cmdExpansionProblem : null;
}

// Delivers each staged path before trying the next file, so a later failure
// cannot hide files that have already been uploaded.
export async function uploadFiles(files, {id, view, epoch}, request = fetch, onUploaded) {
  const paths = [];
  for (const file of files) {
    const query = `id=${encodeURIComponent(id)}&view=${encodeURIComponent(view)}&epoch=${epoch}&name=${encodeURIComponent(file.name)}`;
    let response, reply = {};
    try {
      response = await request(`/api/upload?${query}`, {method:'POST', headers:{'Content-Type':'application/octet-stream'}, body:file});
      reply = await response.json();
    } catch { /* reported below */ }
    if (!response?.ok || typeof reply.path !== 'string') throw new Error(`${file.name} was not uploaded${reply.error ? `: ${reply.error}` : '.'}`);
    paths.push(reply.path);
    onUploaded?.(reply.path);
  }
  return paths;
}
