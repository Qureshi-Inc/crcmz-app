import LiveKit

// Full-device screen capture for Huddle.
// LiveKit's LKSampleHandler handles everything: it connects to the main app via
// a UNIX socket in the shared App Group container (group.me.crcmz.app), receives
// CMSampleBuffers from ReplayKit, and forwards them for LiveKit to encode and send.
class BroadcastHandler: LKSampleHandler {}
