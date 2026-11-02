import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapObsEvent } from './obs-events';

test('maps OBS events to automation events', () => {
  assert.deepEqual(mapObsEvent('CurrentProgramSceneChanged', { sceneName: 'Gameplay' }), { metric: 'obs_scene_changed', scene: 'Gameplay' });
  assert.deepEqual(mapObsEvent('StreamStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' }), { metric: 'obs_stream_started' });
  assert.deepEqual(mapObsEvent('StreamStateChanged', { outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED' }), { metric: 'obs_stream_stopped' });
  assert.deepEqual(mapObsEvent('RecordStateChanged', { outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' }), { metric: 'obs_recording_started' });
  assert.deepEqual(mapObsEvent('ReplayBufferSaved', { savedReplayPath: 'C:/x.mkv' }), { metric: 'obs_replay_saved' });
});

test('ignores transitional states and unrelated events', () => {
  assert.equal(mapObsEvent('StreamStateChanged', { outputState: 'OBS_WEBSOCKET_OUTPUT_STARTING' }), null);
  assert.equal(mapObsEvent('RecordStateChanged', { outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPING' }), null);
  assert.equal(mapObsEvent('InputVolumeChanged', {}), null);
  assert.equal(mapObsEvent('CurrentProgramSceneChanged', {}), null);
});

test('maps reconnecting and input mute changes', () => {
  assert.deepEqual(mapObsEvent('StreamStateChanged', { outputState: 'OBS_WEBSOCKET_OUTPUT_RECONNECTING' }), { metric: 'obs_stream_reconnecting' });
  assert.deepEqual(mapObsEvent('InputMuteStateChanged', { inputName: 'Mic', inputMuted: true }), { metric: 'obs_input_muted', input: 'Mic' });
  assert.deepEqual(mapObsEvent('InputMuteStateChanged', { inputName: 'Mic', inputMuted: false }), { metric: 'obs_input_unmuted', input: 'Mic' });
  assert.equal(mapObsEvent('InputMuteStateChanged', { inputName: 'Mic' }), null);
});
