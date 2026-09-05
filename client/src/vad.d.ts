// ============================================================
// vad.d.ts — types for the vendored @ricky0123/vad-web bundle.
//
// The library is not installed from npm; public/vad/bundle.min.js is a UMD
// build that attaches itself to `window.vad` and expects `window.ort`
// (onnxruntime-web) to already exist. Both are loaded by <script> tags in
// index.html, in that order.
//
// Only the surface the app actually calls is typed here.
// ============================================================

export interface VadProbabilities {
  isSpeech: number;
  notSpeech: number;
}

export interface MicVadOptions {
  /** Samples per VAD frame. 512 @ 16kHz = 32ms. */
  frameSamples: number;
  positiveSpeechThreshold: number;
  negativeSpeechThreshold: number;
  minSpeechFrames: number;
  preSpeechPadFrames: number;
  redemptionFrames: number;
  /** Pass a stream we own; the library then leaves its tracks alone on destroy(). */
  stream?: MediaStream;
  additionalAudioConstraints?: MediaTrackConstraints;
  /** Where the worklet and the Silero weights are fetched from. NOTE: there is
   *  no `modelURL` option for MicVAD — it always loads
   *  `${baseAssetPath}silero_vad_legacy.onnx` and
   *  `${baseAssetPath}vad.worklet.bundle.min.js`. */
  baseAssetPath?: string;
  /** Where onnxruntime-web looks for its .wasm files. */
  onnxWASMBasePath?: string;
  ortConfig?: (ort: OrtLike) => void;
  onSpeechStart?: () => void;
  onSpeechEnd?: (audio: Float32Array) => void;
  onVADMisfire?: () => void;
  onFrameProcessed?: (probabilities: VadProbabilities, frame: Float32Array) => void;
}

export interface MicVadInstance {
  listening: boolean;
  start: () => void;
  pause: () => void;
  destroy: () => void;
}

export interface OrtLike {
  env: {
    wasm: {
      wasmPaths?: string;
      numThreads?: number;
      proxy?: boolean;
    };
  };
}

declare global {
  interface Window {
    vad?: {
      MicVAD: {
        new: (options: Partial<MicVadOptions>) => Promise<MicVadInstance>;
      };
    };
    ort?: OrtLike;
  }
}
