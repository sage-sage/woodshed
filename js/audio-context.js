let sharedContext = null;
let masterGainNode = null;

export function getAudioContext() {
  if (!sharedContext) {
    const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioCtx) {
      throw new Error('Web Audio API is not supported in this browser.');
    }
    sharedContext = new AudioCtx({ latencyHint: 'interactive' });
    masterGainNode = sharedContext.createGain();
    masterGainNode.gain.value = 1.0;
    masterGainNode.connect(sharedContext.destination);
  }
  return sharedContext;
}

export function getMasterGain() {
  getAudioContext();
  return masterGainNode;
}

export async function resumeAudio() {
  const ctx = getAudioContext();
  if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
    await ctx.resume();
  }
  return ctx;
}
