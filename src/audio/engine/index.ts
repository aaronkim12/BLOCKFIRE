/**
 * 절차적 효과음 엔진 공개 API.
 * 게임 코드·Three.js에 의존하지 않으므로 다른 웹 게임에서도 그대로 쓸 수 있다.
 */
export { AudioEngine, type PlayOptions } from './AudioManager';
export { SOUNDS, type SoundDef, type SoundParams, type BusName } from './SoundEffects';
export { MATERIALS, type MaterialName, type MaterialProfile } from './MaterialProfiles';
export { ENVIRONMENTS } from './AudioEffects';
export { analyze, similarity, drawSpectrogram, type SoundMetrics } from './Analysis';
export type { Vec3 } from './SpatialAudio';
