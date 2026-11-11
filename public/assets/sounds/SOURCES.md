# 효과음 출처 및 라이선스

## 1. 녹음 샘플 (이 폴더의 `.mp3`)

| 파일 | 원본 (사용자 제공 사운드 팩) |
|---|---|
| shot_556 | Full Sound/5.56/MP3/556 Single MP3.mp3 |
| shot_762 | Full Sound/7.62x39/MP3/762x39 Single MP3.mp3 |
| shot_762r | Full Sound/7.62x54R/MP3/762x54r Single MP3.mp3 |
| shot_308 | Full Sounds/.308 (7.62x51)/MP3/308 Single.mp3 |
| shot_9mm | Full Sounds/9mm/MP3/9mm Single.mp3 |
| shot_20g | Full Sounds/20 Gauge/MP3/20 Gauge Single.mp3 |
| ar_mag_out / ar_mag_in / ar_charge | Reloads, Cycling & More/MP3/AR Reload Part 1·2, AR Charging Handle |
| ak_mag_out / ak_mag_in / ak_rack | Reloads, Cycling & More/MP3/AK Reload Part 1·2, AK Rack |
| bolt_mag_out / bolt_mag_in / bolt_cycle | Reloads, Cycling & More/MP3/308 Magazine Part 1·2, 308 Bolt Cycle |
| shell_load / pump_rack | Reloads, Cycling & More/MP3/Pump Shell Load, Pump Reload Part 2 |
| pistol_mag_out / pistol_mag_in / pistol_slide / dry_fire | & More/Pistol/MP3/9mm Pistol Reload 1·2, Slide Release, Dry Fire |
| revolver_open / revolver_close / revolver_cock | & More/Revolver/44 Magnum/MP3/44 Magnum Open/Close Cylinder, Cock Hammer |

- 출처: 사용자가 제공한 로컬 폴더 `C:\Users\aaron\Downloads\sound`
- **라이선스: 확인되지 않음.** 사운드 팩에 라이선스 파일이 들어 있지 않았다. 배포하기 전에 원 출처의 사용 조건을 확인해야 한다.
- 샘플을 불러오지 못하면 게임은 같은 역할의 절차적 소리로 자동 대체한다 (`src/audio/Sound.ts`의 `SAMPLE_FALLBACK`).

## 2. 절차적 합성 (파일 없음)

착탄(재질별), 발소리(재질별), 피격·헤드샷, 칼, 폭발, 능력(연막·방벽·비콘·화염/봉쇄 지대·섬광·돌진·오버드라이브),
Core(신호음·설치·해체), 라운드 알림, UI 소리는 `src/audio/engine`의 코드로 실행 중에 합성한다.
외부 음원을 쓰지 않으므로 별도 라이선스 제약이 없다. Tone.js(MIT)를 사용한다.

## 3. 인터넷 에셋

게임에 필요한 효과음을 분석한 결과 위 두 가지로 모든 소리가 채워져 다운로드한 외부 에셋은 없다.
