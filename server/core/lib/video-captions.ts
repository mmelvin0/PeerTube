import { hasAudioStream } from '@peertube/peertube-ffmpeg'
import { buildSUUID } from '@peertube/peertube-node-utils'
import { AbstractTranscriber, TranscriptionModel, WhisperBuiltinModel, transcriberFactory } from '@peertube/peertube-transcription'
import { moveAndProcessCaptionFile } from '@server/helpers/captions-utils.js'
import { isVideoCaptionLanguageValid } from '@server/helpers/custom-validators/video-captions.js'
import { logger, loggerTagsFactory } from '@server/helpers/logger.js'
import { CONFIG } from '@server/initializers/config.js'
import { DIRECTORIES } from '@server/initializers/constants.js'
import { sequelizeTypescript } from '@server/initializers/database.js'
import { VideoCaptionModel } from '@server/models/video/video-caption.js'
import { VideoJobInfoModel } from '@server/models/video/video-job-info.js'
import { VideoModel } from '@server/models/video/video.js'
import { MVideo, MVideoCaption, MVideoFullLight, MVideoUUID, MVideoUrl } from '@server/types/models/index.js'
import { ensureDir, remove } from 'fs-extra/esm'
import { join } from 'path'
import { federateVideoIfNeeded } from './activitypub/videos/federate.js'
import { JobQueue } from './job-queue/job-queue.js'
import { Notifier } from './notifier/notifier.js'
import { TranscriptionJobHandler } from './runners/index.js'
import { VideoPathManager } from './video-path-manager.js'

const lTags = loggerTagsFactory('video-caption')

export async function createLocalCaption (options: {
  video: MVideo
  path: string
  language: string
}) {
  const { language, path, video } = options

  const videoCaption = new VideoCaptionModel({
    videoId: video.id,
    filename: VideoCaptionModel.generateCaptionName(language),
    language
  }) as MVideoCaption

  await moveAndProcessCaptionFile({ path }, videoCaption)

  await sequelizeTypescript.transaction(async t => {
    await VideoCaptionModel.insertOrReplaceLanguage(videoCaption, t)
  })

  return Object.assign(videoCaption, { Video: video })
}

export async function createTranscriptionTaskIfNeeded (video: MVideoUUID & MVideoUrl) {
  if (CONFIG.VIDEO_TRANSCRIPTION.ENABLED !== true) return

  logger.info(`Creating transcription job for ${video.url}`, lTags(video.uuid))

  if (CONFIG.VIDEO_TRANSCRIPTION.REMOTE_RUNNERS.ENABLED === true) {
    await new TranscriptionJobHandler().create({ video })
  } else {
    await JobQueue.Instance.createJob({ type: 'video-transcription', payload: { videoUUID: video.uuid } })
  }

  await VideoJobInfoModel.increaseOrCreate(video.uuid, 'pendingTranscription')
}

// ---------------------------------------------------------------------------
// Transcription task
// ---------------------------------------------------------------------------

let transcriber: AbstractTranscriber

export async function generateSubtitle (options: {
  video: MVideoUUID
}) {
  const inputFileMutexReleaser = await VideoPathManager.Instance.lockFiles(options.video.uuid)

  const outputPath = join(CONFIG.STORAGE.TMP_DIR, 'transcription', buildSUUID())
  await ensureDir(outputPath)

  const binDirectory = join(DIRECTORIES.LOCAL_PIP_DIRECTORY, 'bin')

  try {
    // Lazy load the transcriber
    if (!transcriber) {
      transcriber = transcriberFactory.createFromEngineName({
        engineName: CONFIG.VIDEO_TRANSCRIPTION.ENGINE,
        enginePath: CONFIG.VIDEO_TRANSCRIPTION.ENGINE_PATH,
        logger,
        binDirectory
      })

      if (!CONFIG.VIDEO_TRANSCRIPTION.ENGINE_PATH) {
        logger.info(`Installing transcriber ${transcriber.getEngine().name} to generate subtitles`, lTags())
        await transcriber.install(DIRECTORIES.LOCAL_PIP_DIRECTORY)
      }
    }

    const video = await VideoModel.loadFull(options.video.uuid)
    const file = video.getMaxQualityFile().withVideoOrPlaylist(video)

    await VideoPathManager.Instance.makeAvailableVideoFile(file, async videoInputPath => {
      if (await hasAudioStream(videoInputPath) !== true) {
        logger.info(
          `Do not run transcription for ${video.uuid} in ${outputPath} because it does not contain an audio stream`,
          lTags(video.uuid)
        )

        return
      }

      logger.info(`Running transcription for ${video.uuid} in ${outputPath}`, lTags(video.uuid))

      const transcriptFile = await transcriber.transcribe({
        mediaFilePath: videoInputPath,

        model: CONFIG.VIDEO_TRANSCRIPTION.MODEL_PATH
          ? await TranscriptionModel.fromPath(CONFIG.VIDEO_TRANSCRIPTION.MODEL_PATH)
          : new WhisperBuiltinModel(CONFIG.VIDEO_TRANSCRIPTION.MODEL),

        transcriptDirectory: outputPath,

        format: 'vtt'
      })

      await onTranscriptionEnded({ video, language: transcriptFile.language, vttPath: transcriptFile.path })
    })
  } finally {
    if (outputPath) await remove(outputPath)

    inputFileMutexReleaser()
  }
}

export async function onTranscriptionEnded (options: {
  video: MVideoFullLight
  language: string
  vttPath: string
  lTags?: (string | number)[]
}) {
  const { video, language, vttPath, lTags: customLTags = [] } = options

  await VideoJobInfoModel.decrease(video.uuid, 'pendingTranscription')

  if (!isVideoCaptionLanguageValid(language)) {
    logger.warn(`Invalid transcription language for video ${video.uuid}`, this.lTags(video.uuid))
    return
  }

  if (!video.language) {
    video.language = language
    await video.save()
  }

  const caption = await createLocalCaption({
    video,
    language,
    path: vttPath
  })

  await sequelizeTypescript.transaction(async t => {
    await federateVideoIfNeeded(video, false, t)
  })

  Notifier.Instance.notifyOfGeneratedVideoTranscription(caption)

  logger.info(`Transcription ended for ${video.uuid}`, lTags(video.uuid, ...customLTags))
}
