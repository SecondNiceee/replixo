// ---------------------------------------------------------------------------
// Replixo process-loopback capture helper (Windows 10 2004+ / Windows 11)
//
// Implements Variant A of about/echo-fix/plan.md: WASAPI *process loopback* in
// PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE. Given the Electron main
// PID as argv[1], it captures the ENTIRE system audio mix MINUS the audio of
// Electron's process tree (our renderer that plays the call participants).
//
// That is the OS-level equivalent of "restrictOwnAudio": the participants'
// voices are physically removed before capture, so screen-share-with-audio can
// never echo them back.
//
// Output: raw interleaved 32-bit float PCM, 48000 Hz, 2 channels, written to
// STDOUT as a continuous byte stream. A one-line JSON format descriptor and any
// diagnostics are written to STDERR (never STDOUT, which must stay pure PCM).
//
// Usage:  process-loopback-capture.exe <electron_pid>
//
// Build: see CMakeLists.txt / README.md. Requires the Windows 10 SDK (2004+).
// ---------------------------------------------------------------------------

#include <windows.h>
#include <initguid.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <mmreg.h>
#include <wrl/implements.h>
#include <cstdio>
#include <cstdlib>
#include <atomic>
#include <io.h>
#include <fcntl.h>
#include <cmath>
#include <vector>

using namespace Microsoft::WRL;

// Fixed output format: matches Web Audio (48 kHz, float32) so the renderer can
// feed it straight into an AudioWorklet with no resampling.
static const DWORD  kSampleRate = 48000;
static const WORD   kChannels   = 2;
static const WORD   kBitsPerSample = 32; // IEEE float

static std::atomic<bool> g_running{true};

BOOL WINAPI CtrlHandler(DWORD ctrlType) {
  (void)ctrlType;
  g_running = false;
  return TRUE;
}

// ---------------------------------------------------------------------------
// Async activation handler for ActivateAudioInterfaceAsync. Process loopback
// devices are activated asynchronously; we block on an event until it completes.
// ---------------------------------------------------------------------------
class ActivationHandler
    : public RuntimeClass<RuntimeClassFlags<ClassicCom>,
                          FtmBase,
                          IActivateAudioInterfaceCompletionHandler> {
 public:
  HANDLE done = CreateEvent(nullptr, FALSE, FALSE, nullptr);
  HRESULT activateResult = E_FAIL;
  ComPtr<IAudioClient> client;

  STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation* op) override {
    ComPtr<IUnknown> unknown;
    HRESULT hr = op->GetActivateResult(&activateResult, &unknown);
    if (SUCCEEDED(hr) && SUCCEEDED(activateResult)) {
      unknown.As(&client);
    }
    SetEvent(done);
    return S_OK;
  }
};

static void logErr(const char* msg, HRESULT hr) {
  fprintf(stderr, "[loopback] %s (hr=0x%08lx)\n", msg, (unsigned long)hr);
  fflush(stderr);
}

int wmain(int argc, wchar_t** argv) {
  if (argc < 2) {
    fprintf(stderr, "[loopback] usage: process-loopback-capture.exe <pid>\n");
    return 2;
  }

  DWORD targetPid = (DWORD)_wtoi(argv[1]);
  if (targetPid == 0) {
    fprintf(stderr, "[loopback] invalid pid\n");
    return 2;
  }

  // Make STDOUT binary so PCM bytes are not mangled by CRLF translation.
  _setmode(_fileno(stdout), _O_BINARY);
  SetConsoleCtrlHandler(CtrlHandler, TRUE);

  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) { logErr("CoInitializeEx failed", hr); return 1; }

  // -------------------------------------------------------------------------
  // Activation params: process loopback, EXCLUDE the target process tree.
  // -------------------------------------------------------------------------
  AUDIOCLIENT_ACTIVATION_PARAMS actParams = {};
  actParams.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  actParams.ProcessLoopbackParams.TargetProcessId = targetPid;
  actParams.ProcessLoopbackParams.ProcessLoopbackMode =
      PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;

  PROPVARIANT activateParams = {};
  activateParams.vt = VT_BLOB;
  activateParams.blob.cbSize = sizeof(actParams);
  activateParams.blob.pBlobData = reinterpret_cast<BYTE*>(&actParams);

  ComPtr<ActivationHandler> handler = Make<ActivationHandler>();
  ComPtr<IActivateAudioInterfaceAsyncOperation> asyncOp;

  hr = ActivateAudioInterfaceAsync(
      VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
      __uuidof(IAudioClient),
      &activateParams,
      handler.Get(),
      &asyncOp);
  if (FAILED(hr)) { logErr("ActivateAudioInterfaceAsync failed", hr); return 1; }

  WaitForSingleObject(handler->done, INFINITE);
  if (FAILED(handler->activateResult) || !handler->client) {
    logErr("process loopback activation failed", handler->activateResult);
    return 1;
  }

  ComPtr<IAudioClient> audioClient = handler->client;

  // -------------------------------------------------------------------------
  // Format: interleaved float32, 48 kHz, stereo.
  // -------------------------------------------------------------------------
  WAVEFORMATEX format = {};
  format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
  format.nChannels = kChannels;
  format.nSamplesPerSec = kSampleRate;
  format.wBitsPerSample = kBitsPerSample;
  format.nBlockAlign = (format.nChannels * format.wBitsPerSample) / 8;
  format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
  format.cbSize = 0;

  // Process loopback requires SHARED mode with LOOPBACK + EVENTCALLBACK, and a
  // zero periodicity/buffer (the OS chooses). ~200ms hns buffer is a safe hint.
  REFERENCE_TIME bufferDuration = 2000000; // 200ms in 100-ns units
  hr = audioClient->Initialize(
      AUDCLNT_SHAREMODE_SHARED,
      AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
      bufferDuration,
      0,
      &format,
      nullptr);
  if (FAILED(hr)) { logErr("IAudioClient::Initialize failed", hr); return 1; }

  HANDLE sampleReady = CreateEvent(nullptr, FALSE, FALSE, nullptr);
  hr = audioClient->SetEventHandle(sampleReady);
  if (FAILED(hr)) { logErr("SetEventHandle failed", hr); return 1; }

  ComPtr<IAudioCaptureClient> capture;
  hr = audioClient->GetService(__uuidof(IAudioCaptureClient), &capture);
  if (FAILED(hr)) { logErr("GetService(IAudioCaptureClient) failed", hr); return 1; }

  hr = audioClient->Start();
  if (FAILED(hr)) { logErr("IAudioClient::Start failed", hr); return 1; }

  // Announce the format on STDERR so the parent can configure the worklet.
  fprintf(stderr,
          "{\"type\":\"format\",\"sampleRate\":%lu,\"channels\":%u,\"bitsPerSample\":%u}\n",
          (unsigned long)kSampleRate, (unsigned)kChannels, (unsigned)kBitsPerSample);
  fflush(stderr);

  const DWORD frameBytes = format.nBlockAlign;
  std::vector<float> sanitized;
  unsigned long discontinuities = 0;
  unsigned long timestampErrors = 0;
  unsigned long invalidSamples = 0;

  while (g_running) {
    DWORD wait = WaitForSingleObject(sampleReady, 200);
    if (wait == WAIT_FAILED) break;

    UINT32 packetFrames = 0;
    hr = capture->GetNextPacketSize(&packetFrames);
    if (FAILED(hr)) { logErr("GetNextPacketSize failed", hr); break; }

    while (packetFrames > 0) {
      BYTE* data = nullptr;
      UINT32 available = 0;
      DWORD flags = 0;
      hr = capture->GetBuffer(&data, &available, &flags, nullptr, nullptr);
      if (FAILED(hr)) { logErr("GetBuffer failed", hr); g_running = false; break; }

      const size_t bytes = (size_t)available * frameBytes;

      if (flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) {
        discontinuities++;
        fprintf(stderr, "{\"type\":\"discontinuity\",\"count\":%lu}\n", discontinuities);
        fflush(stderr);
      }
      if (flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR) {
        timestampErrors++;
        fprintf(stderr, "{\"type\":\"timestamp-error\",\"count\":%lu}\n", timestampErrors);
        fflush(stderr);
      }

      if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
        // Emit real silence so the renderer keeps a continuous capture clock.
        sanitized.assign((size_t)available * kChannels, 0.0f);
        fwrite(sanitized.data(), 1, bytes, stdout);
      } else if (data && bytes) {
        const float* input = reinterpret_cast<const float*>(data);
        const size_t sampleCount = (size_t)available * kChannels;
        sanitized.resize(sampleCount);
        for (size_t i = 0; i < sampleCount; i++) {
          const float sample = input[i];
          if (!std::isfinite(sample)) {
            sanitized[i] = 0.0f;
            invalidSamples++;
          } else if (sample > 1.25f) {
            sanitized[i] = 1.25f;
            invalidSamples++;
          } else if (sample < -1.25f) {
            sanitized[i] = -1.25f;
            invalidSamples++;
          } else {
            sanitized[i] = sample;
          }
        }
        fwrite(sanitized.data(), 1, bytes, stdout);
        if (invalidSamples && invalidSamples % 1024 == 1) {
          fprintf(stderr, "{\"type\":\"invalid-samples\",\"count\":%lu}\n", invalidSamples);
          fflush(stderr);
        }
      }
      fflush(stdout);

      hr = capture->ReleaseBuffer(available);
      if (FAILED(hr)) { logErr("ReleaseBuffer failed", hr); g_running = false; break; }

      hr = capture->GetNextPacketSize(&packetFrames);
      if (FAILED(hr)) { g_running = false; break; }
    }
  }

  audioClient->Stop();
  CloseHandle(sampleReady);
  CoUninitialize();
  return 0;
}
