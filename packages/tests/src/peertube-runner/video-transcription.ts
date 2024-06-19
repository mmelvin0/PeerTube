/* eslint-disable @typescript-eslint/no-unused-expressions,@typescript-eslint/require-await */

import { wait } from '@peertube/peertube-core-utils'
import { RunnerJobState } from '@peertube/peertube-models'
import {
  PeerTubeServer,
  cleanupTests,
  createMultipleServers,
  doubleFollow,
  setAccessTokensToServers,
  setDefaultVideoChannel,
  waitJobs
} from '@peertube/peertube-server-commands'
import { checkPeerTubeRunnerCacheIsEmpty } from '@tests/shared/directories.js'
import { PeerTubeRunnerProcess } from '@tests/shared/peertube-runner-process.js'
import { checkCaption, checkLanguage, checkNoCaption, uploadForTranscription } from '@tests/shared/transcription.js'

describe('Test transcription in peertube-runner program', function () {
  let servers: PeerTubeServer[] = []
  let peertubeRunner: PeerTubeRunnerProcess

  before(async function () {
    this.timeout(120_000)

    servers = await createMultipleServers(2)

    await setAccessTokensToServers(servers)
    await setDefaultVideoChannel(servers)

    await doubleFollow(servers[0], servers[1])

    await servers[0].config.enableTranscription({ remote: true })

    const registrationToken = await servers[0].runnerRegistrationTokens.getFirstRegistrationToken()

    peertubeRunner = new PeerTubeRunnerProcess(servers[0])
    await peertubeRunner.runServer()
    await peertubeRunner.registerPeerTubeInstance({ registrationToken, runnerName: 'runner' })
  })

  describe('Running transcription', function () {

    it('Should run transcription on classic file', async function () {
      this.timeout(360000)

      const uuid = await uploadForTranscription(servers[0])
      await waitJobs(servers, { runnerJobs: true })

      await checkCaption(servers, uuid)
      await checkLanguage(servers, uuid, 'en')
    })

    it('Should not run transcription on video without audio stream', async function () {
      this.timeout(360000)

      const uuid = await uploadForTranscription(servers[0], { fixture: 'video_short_no_audio.mp4' })

      await waitJobs(servers)

      let continueWhile = true
      while (continueWhile) {
        await wait(500)

        const { data } = await servers[0].runnerJobs.list({ stateOneOf: [ RunnerJobState.ERRORED ] })

        continueWhile = !data.some(j => j.type === 'video-transcription')
      }

      await checkNoCaption(servers, uuid)
      await checkLanguage(servers, uuid, null)
    })
  })

  describe('Check cleanup', function () {

    it('Should have an empty cache directory', async function () {
      await checkPeerTubeRunnerCacheIsEmpty(peertubeRunner, 'transcription')
    })
  })

  after(async function () {
    if (peertubeRunner) {
      await peertubeRunner.unregisterPeerTubeInstance({ runnerName: 'runner' })
      peertubeRunner.kill()
    }

    await cleanupTests(servers)
  })
})
