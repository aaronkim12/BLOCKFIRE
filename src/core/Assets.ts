import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { track } from './LoadProgress';

/**
 * 외부 에셋 로더 (캐시 포함).
 * 같은 파일을 여러 번 요청해도 한 번만 내려받고 파싱한다.
 * 반환된 원본은 공유되므로 씬에 넣기 전에 반드시 복제해서 쓴다.
 */
const fbxCache = new Map<string, Promise<THREE.Group>>();
const textureCache = new Map<string, Promise<THREE.Texture>>();

// FBX 안에 들어 있는 외부 텍스처 경로(제작자 PC의 절대 경로)는 쓰지 않는다.
// 존재하지 않는 파일을 요청해 404가 나지 않도록 텍스처 로딩을 막는다.
const fbxManager = new THREE.LoadingManager();
fbxManager.setURLModifier((url) =>
  /\.(png|jpe?g|tga|bmp|psd)$/i.test(url) ? 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' : url,
);

export function loadFBX(url: string): Promise<THREE.Group> {
  let p = fbxCache.get(url);
  if (!p) {
    p = track(url.split('/').pop() ?? url, new FBXLoader(fbxManager).loadAsync(url));
    fbxCache.set(url, p);
  }
  return p;
}

export function loadTexture(url: string): Promise<THREE.Texture> {
  let p = textureCache.get(url);
  if (!p) {
    p = track(url.split('/').pop() ?? url, new THREE.TextureLoader().loadAsync(url)).then((t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.magFilter = THREE.NearestFilter;
      t.minFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
      return t;
    });
    textureCache.set(url, p);
  }
  return p;
}
