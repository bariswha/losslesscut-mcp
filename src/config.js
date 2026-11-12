export const FRAME_TOOLS = ['view_frames', 'contact_sheet'];

function readOption(argv, name) {
  const index = argv.indexOf(name);
  if (index !== -1) return argv[index + 1] ?? '';
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : undefined;
}

export function readDisabledTools(argv, env) {
  const list = [readOption(argv, '--disable-tools'), env.LOSSLESSCUT_MCP_DISABLE_TOOLS]
    .filter(Boolean)
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter(Boolean);
  const framesOff = argv.includes('--no-frames') || /^(0|off|false|no)$/i.test(env.LOSSLESSCUT_MCP_FRAMES ?? '');
  return [...new Set([...list, ...(framesOff ? FRAME_TOOLS : [])])];
}
