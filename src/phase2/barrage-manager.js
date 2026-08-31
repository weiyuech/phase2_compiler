import fs from 'fs/promises';
import path from 'path';
import mammoth from 'mammoth';
import { randomUUID } from 'node:crypto';
import { barrageProvider } from '../knowledge/barrage-provider.js';

async function readDocumentContent(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.txt') {
    return await fs.readFile(filePath, 'utf8');
  } else if (ext === '.docx') {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  }
  return '';
}

export class BarrageManager {
  constructor({ tts, llm, tour, uiBridge, checkGoalHandling, checkIsSpeaking, onBarrageSpeechStart, onBarrageSpeechEnd }) {
    this.tts = tts;
    this.llm = llm;
    this.tour = tour;
    this.uiBridge = uiBridge;
    this.checkGoalHandling = checkGoalHandling;
    this.checkIsSpeaking = checkIsSpeaking;
    this.onBarrageSpeechStart = onBarrageSpeechStart;
    this.onBarrageSpeechEnd = onBarrageSpeechEnd;

    this.isPlaying = false;         // A sequence is "in flight" (generating OR playing)
    this._isActuallyPlaying = false; // Real audio is coming out of the speaker RIGHT NOW
    this.isActive = false;
    this.isSleeping = false;
    this.cooldownTimer = null;
    this.latestBarrageEvent = null;
    this.lastRecognizedText = null;
    this._generation = 0;
    this._eventCounter = 0;
    this._latestHandledEvent = 0;
    this._sequence = null;
    this._replyReady = false;
    this._captionId = null;
    this.mp3Count = 0;
    this.llmCount = 0;

    const USER_DATA = process.env.USER_DATA_DIR;
    const DATA_DIR = USER_DATA ? path.join(USER_DATA, 'data') : './data';
    this.audioDir = path.join(DATA_DIR, 'barrage-audio');
    this.configDir = USER_DATA ? path.join(USER_DATA, 'config') : './config';
  }

  async handleOcrText(text) {
    if (!this.isActive) return;
    if (!text || !text.trim()) return;

    // Abandon/drop new replies immediately if host is currently speaking
    if (this.checkIsSpeaking && this.checkIsSpeaking()) {
      console.log('[BarrageManager] Host is speaking. Abandoning incoming barrage reply.');
      return;
    }

    // Deduplicate OCR stream (same as frontend behavior)
    if (text === this.lastRecognizedText) {
      return;
    }
    this.lastRecognizedText = text;

    const generation = this._generation;
    const eventId = ++this._eventCounter;

    // 1. Fetch current global mode
    const config = await barrageProvider.getConfig();
    const mode = config.mode || 'llm-strict';

    let actions = [];

    if (mode === 'mp3') {
      // MP3 mode: Needs concept matching and priority filtering
      const conceptNames = await barrageProvider.listConcepts();
      const matchedConcepts = [];
      const priorityMatchedConcepts = [];

      for (const name of conceptNames) {
        const concept = await barrageProvider.getConcept(name);
        if (!concept) continue;

        const keywords = concept.keywords || [];
        let isMatched = false;
        if (keywords.length === 0) {
          if (text.toLowerCase().includes(name.toLowerCase())) {
            isMatched = true;
          }
        } else {
          const matches = keywords.some(kw => text.toLowerCase().includes(kw.toLowerCase()));
          if (matches) {
            isMatched = true;
          }
        }

        if (isMatched) {
          matchedConcepts.push(name);
          if (concept.priority) {
            priorityMatchedConcepts.push(name);
          }
        }
      }

      // Filter concepts if priority mode is enabled and there are priority matches (only for MP3 mode)
      const isPriorityMode = config.priority_mode === true;
      let finalMatchedConcepts = matchedConcepts;
      if (isPriorityMode && priorityMatchedConcepts.length > 0) {
        console.log(`[BarrageManager] Priority Mode active (MP3). Filtering matches to only priority concepts:`, priorityMatchedConcepts);
        finalMatchedConcepts = priorityMatchedConcepts;
      }

      if (finalMatchedConcepts.length === 0) {
        // MP3 mode does nothing when no concepts match
        return;
      }

      if (config.random_reply === true) {
        const randomConcept = finalMatchedConcepts[Math.floor(Math.random() * finalMatchedConcepts.length)];
        console.log(`[BarrageManager] Random Reply Mode active (MP3). Selecting one matched concept at random: ${randomConcept}`);
        finalMatchedConcepts = [randomConcept];
      }

      for (const name of finalMatchedConcepts) {
        actions.push({ type: 'mp3', conceptName: name });
      }
    } else {
      // LLM mode: Just construct a single LLM action. No concept matching in code.
      // Decision is handled in the LLM prompt.
      actions.push({ type: 'llm', mode });
    }

    if (actions.length === 0) return;

    if (!this.isActive || generation !== this._generation || eventId < this._latestHandledEvent) return;
    this._latestHandledEvent = eventId;
    const event = { id: eventId, text, actions };

    // 4. Busy Check
    const isPlayerPlaying = this.tts.player.isPlaying();
    const isBusy = isPlayerPlaying || this.isPlaying || this.isSleeping;

    if (isBusy) {
      // Zero-latency latest-only buffer: overwrite existing queued actions
      console.log(`[BarrageManager] Robot is busy/sleeping. Buffering latest actions for matched concepts.`);
      this.latestBarrageEvent = event;
    } else {
      // Play immediately
      this.playActionSequence(event);
    }
  }

  async playActionSequence(input) {
    if (this._sequence || !this.isActive) return;
    const event = Array.isArray(input) ? { actions: input, text: this.lastRecognizedText } : input;
    const actions = event.actions;
    const generation = this._generation;
    const run = { controller: new AbortController() };
    this._sequence = run;
    const valid = () => this.isActive && this._sequence === run && !run.controller.signal.aborted;
    this.isPlaying = true;
    // Preparation owns no speaker. Emit sequence hooks only if audio starts;
    // the shared coordinator separately arbitrates each prepared utterance.
    let startedSpeech = false;
    const startSpeech = () => {
      if (!valid() || this.checkIsSpeaking?.()) return false;
      this._replyReady = false;
      if (startedSpeech) return true;
      startedSpeech = true;
      this._isActuallyPlaying = true;
      this.onBarrageSpeechStart?.();
      return true;
    };

    try {
      for (const action of actions) {
        const utteranceId = randomUUID();
        if (!valid()) break;

        if (action.type === 'mp3') {
          const dirPath = path.join(this.audioDir, action.conceptName);
          let mp3Files = [];
          try {
            const files = await fs.readdir(dirPath);
            mp3Files = files.filter(f => f.toLowerCase().endsWith('.mp3'));
          } catch (err) {
            // Directory does not exist
          }

          if (mp3Files.length > 0) {
            const randomFile = mp3Files[Math.floor(Math.random() * mp3Files.length)];
            const mp3Path = path.join(dirPath, randomFile);
            if (!valid()) break;
            console.log(`[BarrageManager] Playing MP3: ${mp3Path}`);

            let didStart = false;
            try {
              const result = await this.tts.speakFile(mp3Path, {
                signal: run.controller.signal, utteranceId,
                onPrepared: () => { if (valid()) this._replyReady = true; },
                beforePlay: () => valid() && !this.checkIsSpeaking?.(),
                onAudioStart: () => {
                  if (!startSpeech()) return false;
                  didStart = true;
                  this._captionId = utteranceId;
                  this.uiBridge.broadcast('SPEECH_START', { utteranceId, source: 'barrage', mp3_file: mp3Path });
                  return true;
                },
              });
              if (valid() && result?.ok !== false) this.mp3Count++;
              if (valid() && result?.ok === false && !result.aborted) {
                this.uiBridge.broadcast('ERROR', { message: '弹幕音频播放失败: ' + (result.error?.message || '未知错误') });
              }
            } finally {
              if (valid() && didStart) this.uiBridge.broadcast('SPEECH_END', { utteranceId, source: 'barrage' });
              if (valid()) { this._replyReady = false; this._captionId = null; }
            }
          } else {
            console.warn(`[BarrageManager] No MP3 files found in directory: ${dirPath}`);
          }
        } else if (action.type === 'llm') {
          let docContent = '';
          const globalConfig = await barrageProvider.getConfig();
          if (globalConfig && globalConfig.document_name) {
            const docPath = path.join(barrageProvider.docsDir, globalConfig.document_name);
            try {
              docContent = await readDocumentContent(docPath);
            } catch (err) {
              console.error(`[BarrageManager] Failed to read universal document: ${docPath}`, err.message);
            }
          }

          if (!valid()) break;

          console.log(`[BarrageManager] Processing OCR text crop via LLM.`);

          // Load system prompt based on LLM mode
          const promptFileName = action.mode === 'llm-strict' ? 'barrage-prompt-name.txt' : 'barrage-prompt-general.txt';
          const promptPath = path.join(this.configDir, promptFileName);
          let systemPrompt = '';
          try {
            systemPrompt = await fs.readFile(promptPath, 'utf8');
          } catch (err) {
            systemPrompt = action.mode === 'llm-strict'
              ? '你是一个亲切活泼的直播间助手。请根据 <document> 事实对 <barrage_text> 中的提问进行自然播报回答。开头感谢网名。智能去杂留名：仅剥离网名前最置的等级、乱码等符号噪音，100%保留其余网名主体。依托事实自然回答，控制在15字左右，严禁捏造参数；无答案提问【只能且必须直接】输出：“关于这方面，您可以先点个关注，然后私信咱们的后台客服获取详细资料哦～”，绝对禁止自作聪明猜答或表达不知道、没说。严禁暴露AI或提及文档。示范样例：如果问手表有粉色吗（文档无），必须直接输出：“谢谢【网名】的提问，关于这方面，您可以先点个关注，然后私信咱们的后台客服获取详细资料哦～”'
              : '你是一个亲切活泼的直播间助手。请根据 <document> 事实对 <barrage_text> 中的提问进行自然播报回答（忽略网名）。直接解答。依托事实进行自然扩写，严禁捏造任何文档未提及参数；无答案提问【只能且必须直接】输出：“关于这方面，您可以先点个关注，然后私信咱们的后台客服获取详细资料哦～”，绝对禁止自作聪明猜答或表达不知道、没说。严禁暴露AI或提及文档，解答控制在15字左右。';
          }

          if (globalConfig && globalConfig.random_reply === true) {
            systemPrompt += "\n\n【Random Reply Rule / 随机回复规则】\n" +
              "If the input contains multiple user messages or different questions, you do not need to answer all of them. " +
              "Instead, randomly select one or two questions/users to answer, and ignore the rest.\n" +
              "（如果输入中包含多个不同的提问或弹幕，你不需要全部回答。请随机选择其中的一个或两个进行回答，并忽略其余的提问。）";
          }

          if (globalConfig && globalConfig.priority_mode === true) {
            systemPrompt += "\n\n【Priority Reply Rule / 优先回复规则】\n" +
              "如果输入中包含多个不同的提问或弹幕，请优先挑选出其中最重要、最紧迫的提问进行精准解答，并忽略其余的无关联提问或闲聊话语。";
          }

          // User prompt formatted with XML tags
          const userPrompt = `<barrage_text>\n${event.text}\n</barrage_text>\n\n<document>\n${docContent.trim()}\n</document>`;

          if (!valid()) break;

          console.log(`[BarrageManager] Calling LLM. System prompt size: ${systemPrompt.length}. User prompt: ${userPrompt.trim()}`);

          // ─── Phase 1: LLM text generation. Cruising audio KEEPS playing during this. ───
          let replyText;
          try {
            const resultText = await this.llm.rewriteBarrage(systemPrompt, userPrompt);
            if (!valid()) break;
            if (!resultText || !resultText.trim()) {
              console.log('[BarrageManager] ⚠️ 大模型调用失败或未返回有效文本，本次播放已跳过。');
              continue;
            }
            replyText = resultText.trim();
          } catch (err) {
            console.error('[BarrageManager] LLM 调用出错:', err.message);
            continue;
          }

          // ─── Phase 2: sentence preparation and coordinated handoff ───
          // A ready reply waits for the current TTS sentence. Host speech remains
          // an immediate veto; a discarded reply never claims a caption/speaker.
          let didFireStart = false;
          try {
            const res = await this.tts.speak(replyText, {
              signal: run.controller.signal, utteranceId,
              onPrepared: () => { if (valid()) this._replyReady = true; },
              beforePlay: () => {
                if (!valid()) return false;
                if (this.checkIsSpeaking && this.checkIsSpeaking()) {
                  console.log('[BarrageManager] 主播仍在说话，此次生成的回复被丢弃（不播放，不打断巡游）。');
                  return false;
                }
                return true;
              },
              onAudioStart: () => {
                if (!startSpeech()) return false;
                this._captionId = utteranceId;
                this.uiBridge.broadcast('SPEECH_START', { text: replyText, utteranceId, source: 'barrage' });
                didFireStart = true;
                return true;
              },
              onSentenceStart: ({ text, index, resumed = false }) => {
                if (valid() && didFireStart) this.uiBridge.broadcast('SPEECH_SENTENCE', { utteranceId, source: 'barrage', text, index, resumed });
              },
            });
            if (res && res.aborted) {
              // beforePlay rejected: silent discard, cruising was never paused
            } else if (res && res.ok === false) {
              console.error('[BarrageManager] 对话合成播放失败:', res.error?.message ?? res.error);
              if (valid()) this.uiBridge.broadcast('ERROR', { message: '弹幕语音准备/播放失败: ' + (res.error?.message || '未知错误') });
            } else if (valid()) {
              this.llmCount++;
            }
          } catch (err) {
            console.error('[BarrageManager] 对话合成播放出错:', err.message);
            if (valid()) this.uiBridge.broadcast('ERROR', { message: '弹幕语音准备/播放失败: ' + err.message });
          } finally {
            if (valid() && didFireStart) this.uiBridge.broadcast('SPEECH_END', { utteranceId, source: 'barrage' });
            if (valid()) { this._replyReady = false; this._captionId = null; }
          }
        }
      }
    } catch (err) {
      console.error('[BarrageManager] Error during action playback:', err.message);
    } finally {
      if (this._sequence !== run) return;
      // Only the owning run may release speech or schedule the next event.
      // Keep the run busy while loading cooldown settings; otherwise a new OCR
      // event can start another job before this run has committed its cooldown.
      this._isActuallyPlaying = false;
      if (startedSpeech) {
        this.onBarrageSpeechEnd?.();
      }

      // 2. Finished the current sequence. Check if we need to enter a cooldown sleep period.
      if (this.isActive) {
        let globalConfig = { cooldown: 0 };
        try {
          globalConfig = await barrageProvider.getConfig();
        } catch (err) {
          console.error('[BarrageManager] Failed to read config in cooldown check:', err.message);
        }
        
        if (!this.isActive || generation !== this._generation || this._sequence !== run) return;
        const cooldown = typeof globalConfig.cooldown === 'number' ? globalConfig.cooldown : 0;
        this._sequence = null;
        this.isPlaying = false;
        
        if (cooldown > 0) {
          console.log(`[BarrageManager] Starting cooldown sleep for ${cooldown} seconds.`);
          this.isSleeping = true;
          this.cooldownTimer = setTimeout(() => {
            this.cooldownTimer = null;
            this.isSleeping = false;
            console.log('[BarrageManager] Cooldown sleep finished.');
            
            if (this.isActive && generation === this._generation && this.latestBarrageEvent) {
              console.log('[BarrageManager] Playback woke up and found buffered barrage event. Executing...');
              const nextActions = this.latestBarrageEvent;
              this.latestBarrageEvent = null;
              this.playActionSequence(nextActions);
            }
          }, cooldown * 1000);
        } else {
          // cooldown === 0: original seamless check
          if (this.latestBarrageEvent) {
            console.log('[BarrageManager] Transitioning to buffered latest event immediately.');
            const nextActions = this.latestBarrageEvent;
            this.latestBarrageEvent = null;
            this.playActionSequence(nextActions);
          }
        }
      } else {
        this._sequence = null;
        this.isPlaying = false;
      }
    }
  }

  cancelPendingSpeech() {
    this._generation++;
    const run = this._sequence;
    this._sequence = null;
    run?.controller.abort();
    const wasSpeaking = this._isActuallyPlaying;
    this.isPlaying = false;
    this._isActuallyPlaying = false;
    this._replyReady = false;
    this.latestBarrageEvent = null;
    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    this.cooldownTimer = null;
    this.isSleeping = false;
    this.tts.stop();
    if (wasSpeaking) this.onBarrageSpeechEnd?.();
    if (this._captionId) this.uiBridge.broadcast('SPEECH_END', { utteranceId: this._captionId, source: 'barrage' });
    this._captionId = null;
  }

  stop() {
    this.isActive = false;
    this.cancelPendingSpeech();
  }

  stopSpeech() {
    // A generating reply may continue; its final gate drops it if host speech
    // persists. A prepared boundary-waiting reply must not replay after host end.
    if (!this._isActuallyPlaying && !this._replyReady) return;
    this.cancelPendingSpeech();
  }
}
