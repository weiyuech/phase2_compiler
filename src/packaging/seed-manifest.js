// A closed list of release defaults, shared by staging and first-run seeding.
// Models are immutable package resources, not user data to copy on upgrade.
export const SEED_CONFIG_FILES = Object.freeze([
  'banned-words.txt',
  'llm-system-prompt.txt',
  'barrage-prompt-name.txt',
  'barrage-prompt-general.txt',
])

export const SEED_MODEL_FILES = Object.freeze([
  'PP-OCRv6_medium_det.onnx',
  'PP-OCRv6_medium_rec.onnx',
  'ppocrv6_dict.txt',
])

export const SEED_DATA_FILES = Object.freeze({
  'tour-list.json': '[]\n',
  'transit-audio.json': JSON.stringify({
    enabled: false, type: 'tts', text: '', mp3_file: '', mp3_files: [], mp3_mode: 'repeat',
  }, null, 2) + '\n',
  'audio-output.json': JSON.stringify({ destination: 'local', robotVolumePercent: 100 }, null, 2) + '\n',
  'barrage-knowledge/config.json': JSON.stringify({
    mode: 'llm-strict', document_name: '', priority_mode: false, random_reply: false, cooldown: 3,
  }, null, 2) + '\n',
})

export const SEED_EMPTY_DIRECTORIES = Object.freeze([
  'flatfiles',
  'barrage-knowledge/concepts',
  'barrage-knowledge/documents',
  'barrage-audio',
  'cruising-audio',
  'tts-cache',
])

export const SEED_BLANK_ENV_KEYS = Object.freeze([
  'ROBOT_URL', 'NGROK_AUTHTOKEN',
  'DEEPSEEK_ARK_API_KEY', 'DEEPSEEK_ARK_MODEL',
  'TRANSIT_DEEPSEEK_ARK_API_KEY', 'TRANSIT_DEEPSEEK_ARK_MODEL',
  'BARRAGE_DEEPSEEK_ARK_API_KEY', 'BARRAGE_DEEPSEEK_ARK_MODEL',
  'DOUBAO_API_KEY', 'DOUBAO_MODEL', 'DEEPSEEK_API_KEY', 'QWEN_API_KEY',
  'TTS_API_KEY', 'TTS_APP_ID', 'TTS_ACCESS_TOKEN', 'TTS_VOICE_TYPE',
  'TTS_CLUSTER', 'TTS_RESOURCE_ID',
  'TRANSIT_DOUBAO_API_KEY', 'TRANSIT_DOUBAO_MODEL', 'TRANSIT_DEEPSEEK_API_KEY', 'TRANSIT_QWEN_API_KEY',
  'TRANSIT_TTS_API_KEY', 'TRANSIT_TTS_APP_ID', 'TRANSIT_TTS_ACCESS_TOKEN',
  'TRANSIT_TTS_VOICE_TYPE', 'TRANSIT_TTS_CLUSTER', 'TRANSIT_TTS_RESOURCE_ID',
  'BARRAGE_DOUBAO_API_KEY', 'BARRAGE_DOUBAO_MODEL', 'BARRAGE_DEEPSEEK_API_KEY', 'BARRAGE_QWEN_API_KEY',
  'BARRAGE_TTS_API_KEY', 'BARRAGE_TTS_APP_ID', 'BARRAGE_TTS_ACCESS_TOKEN',
  'BARRAGE_TTS_VOICE_TYPE', 'BARRAGE_TTS_CLUSTER', 'BARRAGE_TTS_RESOURCE_ID',
])
