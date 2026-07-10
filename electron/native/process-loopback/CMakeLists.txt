cmake_minimum_required(VERSION 3.20)
project(process_loopback_capture CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Process loopback (AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK) requires the
# Windows 10 SDK 2004 (10.0.19041.0) or newer.
add_executable(process-loopback-capture loopback-capture.cpp)

target_link_libraries(process-loopback-capture
  ole32
  mmdevapi
  ksuser
)

# Unicode entry point (wmain) + release optimizations.
target_compile_definitions(process-loopback-capture PRIVATE UNICODE _UNICODE)

if(MSVC)
  target_compile_options(process-loopback-capture PRIVATE /O2 /EHsc)
endif()

set_target_properties(process-loopback-capture PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_SOURCE_DIR}/bin"
)
