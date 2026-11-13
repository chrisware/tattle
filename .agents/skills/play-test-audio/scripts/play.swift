import AVFAudio
import CoreAudio
import Darwin
import Foundation

// Plays test audio into the existing desk route. Does not change the system default
// input or output, and does not touch Audio MIDI Setup.
//
//   play [--check] [--blackhole] [--once] [--left A --right B] [stereo.wav]
//   play --self-test
//
// Stereo file: left = interviewer (host), right = guest (remote).
// Two files: each file's first channel, looped independently.

signal(SIGHUP, SIG_IGN)
signal(SIGPIPE, SIG_IGN)

let aggregateUID = "~:AMS2_StackedOutput:0"
let blackHoleUID = "BlackHole2ch_UID"
let speakerUID = "BuiltInSpeakerDevice"

struct Args {
	var checkOnly = false
	var selfTest = false
	var blackholeOnly = false
	var once = false
	var left: String?
	var right: String?
	var stereo: String?
}

func fail(_ msg: String) -> Never {
	fputs("error: \(msg)\n", stderr)
	exit(2)
}

func parse() -> Args {
	var out = Args()
	var i = 1
	let argv = CommandLine.arguments
	while i < argv.count {
		let a = argv[i]
		switch a {
		case "--check":
			out.checkOnly = true
		case "--self-test":
			out.selfTest = true
		case "--blackhole":
			out.blackholeOnly = true
		case "--once":
			out.once = true
		case "--left", "--right":
			i += 1
			if i >= argv.count { fail("\(a) needs a path") }
			if a == "--left" { out.left = argv[i] } else { out.right = argv[i] }
		default:
			if a.hasPrefix("-") { fail("unknown flag \(a)") }
			if out.stereo != nil { fail("only one stereo file") }
			out.stereo = a
		}
		i += 1
	}
	return out
}

func allDeviceIDs() -> [AudioDeviceID] {
	var addr = AudioObjectPropertyAddress(
		mSelector: kAudioHardwarePropertyDevices,
		mScope: kAudioObjectPropertyScopeGlobal,
		mElement: kAudioObjectPropertyElementMain)
	var size: UInt32 = 0
	let sys = AudioObjectID(kAudioObjectSystemObject)
	guard AudioObjectGetPropertyDataSize(sys, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
	let n = Int(size) / MemoryLayout<AudioDeviceID>.size
	var ids = [AudioDeviceID](repeating: 0, count: n)
	guard AudioObjectGetPropertyData(sys, &addr, 0, nil, &size, &ids) == noErr else { return [] }
	return ids
}

func stringProp(_ id: AudioObjectID, _ sel: AudioObjectPropertySelector) -> String? {
	var addr = AudioObjectPropertyAddress(
		mSelector: sel,
		mScope: kAudioObjectPropertyScopeGlobal,
		mElement: kAudioObjectPropertyElementMain)
	var cf: Unmanaged<CFString>?
	var sz = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
	guard AudioObjectGetPropertyData(id, &addr, 0, nil, &sz, &cf) == noErr else { return nil }
	return cf?.takeRetainedValue() as String?
}

func deviceID(uid: String) -> AudioDeviceID? {
	for id in allDeviceIDs() {
		if stringProp(id, kAudioDevicePropertyDeviceUID) == uid { return id }
	}
	return nil
}

func subdeviceUIDs(_ id: AudioDeviceID) -> [String] {
	var addr = AudioObjectPropertyAddress(
		mSelector: kAudioAggregateDevicePropertyActiveSubDeviceList,
		mScope: kAudioObjectPropertyScopeGlobal,
		mElement: kAudioObjectPropertyElementMain)
	var size: UInt32 = 0
	guard AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
	let n = Int(size) / MemoryLayout<AudioObjectID>.size
	var ids = [AudioObjectID](repeating: 0, count: n)
	guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &ids) == noErr else { return [] }
	return ids.compactMap { stringProp($0, kAudioDevicePropertyDeviceUID) }
}

func findAggregate() -> AudioDeviceID? {
	if let id = deviceID(uid: aggregateUID) {
		let subs = subdeviceUIDs(id)
		if subs.contains(speakerUID) && subs.contains(blackHoleUID) { return id }
	}
	for id in allDeviceIDs() {
		let subs = subdeviceUIDs(id)
		if subs.contains(speakerUID) && subs.contains(blackHoleUID) { return id }
	}
	return nil
}

func bind(_ engine: AVAudioEngine, device: AudioDeviceID) -> Bool {
	guard let au = engine.outputNode.audioUnit else { return false }
	var dev = device
	let set = AudioUnitSetProperty(
		au,
		kAudioOutputUnitProperty_CurrentDevice,
		kAudioUnitScope_Global,
		0,
		&dev,
		UInt32(MemoryLayout<AudioDeviceID>.size))
	return set == noErr
}

func bindOutput(_ engine: AVAudioEngine, device: AudioDeviceID) {
	guard bind(engine, device: device) else { fail("could not select device \(device); not changing Audio MIDI Setup") }
}

/// Wall-clock stamp on every status line: a route change mid-tape is otherwise indistinguishable from a stall.
func log(_ message: String) {
	let f = DateFormatter()
	f.dateFormat = "HH:mm:ss.SSS"
	fputs("[\(f.string(from: Date()))] \(message)\n", stderr)
	fflush(stderr)
}

func confirmDevice(_ engine: AVAudioEngine, wanted: AudioDeviceID) {
	let stuck = engine.outputNode.auAudioUnit.deviceID
	if stuck != wanted { fail("output device reset to \(stuck), wanted \(wanted)") }
}

final class Peaks {
	var left: Float = 0
	var right: Float = 0
	let lock = NSLock()
	func note(_ buffer: AVAudioPCMBuffer) {
		guard let ch = buffer.floatChannelData else { return }
		let n = Int(buffer.frameLength)
		let channels = Int(buffer.format.channelCount)
		var l: Float = 0
		var r: Float = 0
		if channels > 0 {
			let s = ch[0]
			for i in 0..<n { l = max(l, abs(s[i])) }
		}
		if channels > 1 {
			let s = ch[1]
			for i in 0..<n { r = max(r, abs(s[i])) }
		} else {
			r = l
		}
		lock.lock()
		left = max(left, l)
		right = max(right, r)
		lock.unlock()
	}
	func printLine() {
		lock.lock()
		let l = left
		let r = right
		lock.unlock()
		log(String(format: "mixer peak L %.4f R %.4f", l, r))
	}
}

func installMeter(_ engine: AVAudioEngine, format: AVAudioFormat?, peaks: Peaks) {
	engine.mainMixerNode.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in
		peaks.note(buffer)
	}
}

func schedulePeak(_ peaks: Peaks) {
	DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { peaks.printLine() }
}

func loadMono(path: String) throws -> AVAudioPCMBuffer {
	let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
	let frames = AVAudioFrameCount(file.length)
	if frames == 0 { fail("empty file \(path)") }
	if file.length > 48_000 * 60 * 15 { fail("file longer than 15 minutes: \(path)") }
	guard let src = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: frames) else {
		fail("could not allocate \(path)")
	}
	try file.read(into: src)
	guard let monoFmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: file.processingFormat.sampleRate, channels: 1, interleaved: false),
	      let mono = AVAudioPCMBuffer(pcmFormat: monoFmt, frameCapacity: frames),
	      let conv = AVAudioConverter(from: file.processingFormat, to: monoFmt) else {
		fail("could not convert \(path)")
	}
	var used = false
	var err: NSError?
	conv.convert(to: mono, error: &err) { _, status in
		if used {
			status.pointee = .endOfStream
			return nil
		}
		used = true
		status.pointee = .haveData
		return src
	}
	if let err { throw err }
	if mono.frameLength == 0 { fail("converted empty \(path)") }
	return mono
}

func resample(_ buf: AVAudioPCMBuffer, to rate: Double) throws -> [Float] {
	let srcFmt = buf.format
	if abs(srcFmt.sampleRate - rate) < 1, let ch = buf.floatChannelData {
		return Array(UnsafeBufferPointer(start: ch[0], count: Int(buf.frameLength)))
	}
	guard let dstFmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false) else {
		fail("bad resample format")
	}
	let cap = AVAudioFrameCount(Double(buf.frameLength) * rate / srcFmt.sampleRate) + 64
	guard let dst = AVAudioPCMBuffer(pcmFormat: dstFmt, frameCapacity: cap),
	      let conv = AVAudioConverter(from: srcFmt, to: dstFmt) else {
		fail("could not resample")
	}
	var used = false
	var err: NSError?
	conv.convert(to: dst, error: &err) { _, status in
		if used {
			status.pointee = .endOfStream
			return nil
		}
		used = true
		status.pointee = .haveData
		return buf
	}
	if let err { throw err }
	guard let ch = dst.floatChannelData, dst.frameLength > 0 else { fail("resample produced no samples") }
	return Array(UnsafeBufferPointer(start: ch[0], count: Int(dst.frameLength)))
}

final class Split {
	let left: [Float]
	let right: [Float]
	let loop: Bool
	var li = 0
	var ri = 0
	var ended = false

	init(left: [Float], right: [Float], loop: Bool) {
		self.left = left
		self.right = right
		self.loop = loop
	}

	func pull(_ n: Int, leftOut: UnsafeMutablePointer<Float>, rightOut: UnsafeMutablePointer<Float>) {
		for i in 0..<n {
			leftOut[i] = sample(left, &li)
			rightOut[i] = sample(right, &ri)
		}
		if !loop && li >= left.count && ri >= right.count { ended = true }
	}

	private func sample(_ data: [Float], _ pos: inout Int) -> Float {
		if data.isEmpty { return 0 }
		if pos < data.count {
			let v = data[pos]
			pos += 1
			return v
		}
		if loop {
			pos = 1
			return data[0]
		}
		return 0
	}
}

func writeSplit(_ split: Split, _ abl: UnsafeMutablePointer<AudioBufferList>, frames: Int) {
	let buffers = UnsafeMutableAudioBufferListPointer(abl)
	if buffers.count >= 2, let l = buffers[0].mData, let r = buffers[1].mData {
		split.pull(frames, leftOut: l.assumingMemoryBound(to: Float.self), rightOut: r.assumingMemoryBound(to: Float.self))
		return
	}
	if buffers.count == 1, buffers[0].mNumberChannels == 2, let p = buffers[0].mData {
		let s = p.assumingMemoryBound(to: Float.self)
		let tmpL = UnsafeMutablePointer<Float>.allocate(capacity: frames)
		let tmpR = UnsafeMutablePointer<Float>.allocate(capacity: frames)
		defer { tmpL.deallocate(); tmpR.deallocate() }
		split.pull(frames, leftOut: tmpL, rightOut: tmpR)
		for i in 0..<frames {
			s[i * 2] = tmpL[i]
			s[i * 2 + 1] = tmpR[i]
		}
		return
	}
	fail("unexpected mixer layout")
}

func playSplit(leftPath: String, rightPath: String, device: AudioDeviceID, once: Bool, label: String) throws {
	let leftBuf = try loadMono(path: leftPath)
	let rightBuf = try loadMono(path: rightPath)
	let rate = 48_000.0
	let left = try resample(leftBuf, to: rate)
	let right = try resample(rightBuf, to: rate)
	guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 2, interleaved: false) else {
		fail("bad mix format")
	}
	let split = Split(left: left, right: right, loop: !once)
	let engine = AVAudioEngine()
	let node = AVAudioSourceNode(format: format) { silence, _, frameCount, abl -> OSStatus in
		silence.pointee = false
		writeSplit(split, abl, frames: Int(frameCount))
		return noErr
	}
	engine.attach(node)
	bindOutput(engine, device: device)
	engine.connect(node, to: engine.mainMixerNode, format: format)
	engine.connect(engine.mainMixerNode, to: engine.outputNode, format: nil)
	let peaks = Peaks()
	installMeter(engine, format: format, peaks: peaks)
	try engine.start()
	confirmDevice(engine, wanted: device)
	supervise(engine) {}
	log("playing \(label) on \(stringProp(device, kAudioObjectPropertyName) ?? "?") device \(device) rate \(engine.outputNode.outputFormat(forBus: 0).sampleRate); \(routeNote(device)); system default unchanged")
	schedulePeak(peaks)
	if once {
		DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
			func poll() {
				if split.ended {
					peaks.printLine()
					exit(0)
				}
				DispatchQueue.main.asyncAfter(deadline: .now() + 0.2, execute: poll)
			}
			poll()
		}
	}
	RunLoop.main.run()
}

func playStereo(path: String, device: AudioDeviceID, once: Bool) throws {
	let url = URL(fileURLWithPath: path)
	let file = try AVAudioFile(forReading: url)
	guard file.length > 0 else { fail("empty file \(path)") }
	let engine = AVAudioEngine()
	let player = AVAudioPlayerNode()
	engine.attach(player)
	bindOutput(engine, device: device)
	engine.connect(player, to: engine.mainMixerNode, format: file.processingFormat)
	engine.connect(engine.mainMixerNode, to: engine.outputNode, format: nil)
	let peaks = Peaks()
	installMeter(engine, format: file.processingFormat, peaks: peaks)
	try engine.start()
	confirmDevice(engine, wanted: device)

	// Position in frames, tracked so a route change resumes the tape where it was: stopping the engine discards the
	// player node's scheduled buffer, and a bare play() then outputs nothing at all.
	var start: AVAudioFramePosition = 0
	var current: AVAudioFramePosition = 0

	func schedule(from frame: AVAudioFramePosition) {
		let remaining = file.length - frame
		guard remaining > 0 else {
			if once {
				peaks.printLine()
				exit(0)
			}
			start = 0
			schedule(from: 0)
			return
		}
		player.scheduleSegment(file, startingFrame: frame, frameCount: AVAudioFrameCount(remaining), at: nil) {
			DispatchQueue.main.async {
				if once {
					peaks.printLine()
					exit(0)
				}
				start = 0
				schedule(from: 0)
			}
		}
		start = frame
	}

	schedule(from: 0)
	player.play()

	let tracker = Timer(timeInterval: 0.25, repeats: true) { _ in
		guard player.isPlaying, let nodeTime = player.lastRenderTime, let t = player.playerTime(forNodeTime: nodeTime) else { return }
		let at = start + AVAudioFramePosition(t.sampleTime)
		if at >= 0 && at < file.length { current = at }
	}
	RunLoop.main.add(tracker, forMode: .common)

	supervise(engine) {
		player.stop()
		schedule(from: current)
		player.play()
	}
	let rate = engine.outputNode.outputFormat(forBus: 0).sampleRate
	let name = stringProp(device, kAudioObjectPropertyName) ?? "?"
	log("playing \(path) on \(name) device \(device) rate \(rate); \(routeNote(device)); system default unchanged")
	schedulePeak(peaks)
	RunLoop.main.run()
}

func routeNote(_ device: AudioDeviceID) -> String {
	if stringProp(device, kAudioDevicePropertyDeviceUID) == blackHoleUID { return "blackhole-only" }
	return "speakers + BlackHole"
}

func currentDevice(blackholeOnly: Bool) -> AudioDeviceID? {
	blackholeOnly ? deviceID(uid: blackHoleUID) : findAggregate()
}

func selectDevice(blackholeOnly: Bool) -> AudioDeviceID {
	if blackholeOnly {
		guard let id = currentDevice(blackholeOnly: true) else {
			fail("BlackHole 2ch \(blackHoleUID) not found; not changing Audio MIDI Setup")
		}
		return id
	}
	guard let id = currentDevice(blackholeOnly: false) else {
		fail("Multi-Output Device with speakers and BlackHole not found; refusing to play to speakers alone; not changing Audio MIDI Setup")
	}
	return id
}

/// Core Audio stops the engine whenever the route is rebuilt. Opening the desk input does that: the capture helper
/// sets BlackHole's rate, the aggregate is rebuilt, and it comes back with a new device id. A stale id makes
/// AudioUnitSetProperty fail, so the retry must not exit: look the device up again on the next tick.
func supervise(_ engine: AVAudioEngine, resume: @escaping () -> Void) {
	let timer = Timer(timeInterval: 0.5, repeats: true) { _ in
		if engine.isRunning { return }
		guard let device = currentDevice(blackholeOnly: args.blackholeOnly) else { return }
		engine.stop()
		guard bind(engine, device: device) else { return }
		do {
			try engine.start()
		} catch {
			log("restart failed: \(error)")
			return
		}
		resume()
		let name = stringProp(device, kAudioObjectPropertyName) ?? "?"
		log("audio route changed; restarted on \(name) device \(device)")
	}
	RunLoop.main.add(timer, forMode: .common)
}

func runSelfTest() throws {
	let rate = 48_000.0
	let n = 4800
	guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 2, interleaved: false) else {
		fail("bad self-test format")
	}
	let split = Split(left: [Float](repeating: 0.5, count: n), right: [Float](repeating: 0.25, count: n), loop: false)
	let engine = AVAudioEngine()
	try engine.enableManualRenderingMode(.offline, format: format, maximumFrameCount: 4096)
	let node = AVAudioSourceNode(format: format) { silence, _, frameCount, abl -> OSStatus in
		silence.pointee = false
		writeSplit(split, abl, frames: Int(frameCount))
		return noErr
	}
	engine.attach(node)
	engine.connect(node, to: engine.mainMixerNode, format: format)
	engine.connect(engine.mainMixerNode, to: engine.outputNode, format: format)
	try engine.start()
	guard let buf = AVAudioPCMBuffer(pcmFormat: engine.manualRenderingFormat, frameCapacity: 4096) else {
		fail("no render buffer")
	}
	var sumL: Float = 0
	var sumR: Float = 0
	var seen = 0
	while seen < n {
		let chunk = AVAudioFrameCount(min(4096, n - seen))
		let status = try engine.renderOffline(chunk, to: buf)
		if status != .success { fail("render status \(status.rawValue)") }
		guard let ch = buf.floatChannelData else { fail("no rendered channels") }
		let frames = Int(buf.frameLength)
		for i in 0..<frames {
			sumL += abs(ch[0][i])
			sumR += abs(ch[1][i])
		}
		seen += frames
	}
	let meanL = sumL / Float(seen)
	let meanR = sumR / Float(seen)
	if abs(meanL - 0.5) > 0.02 || abs(meanR - 0.25) > 0.02 {
		fail(String(format: "channel split drifted L %.4f R %.4f", meanL, meanR))
	}
	print(String(format: "self-test ok L %.4f R %.4f", meanL, meanR))
}

let args = parse()

do {
	if args.selfTest {
		try runSelfTest()
		exit(0)
	}
	let device = selectDevice(blackholeOnly: args.blackholeOnly)
	if args.checkOnly {
		let name = stringProp(device, kAudioObjectPropertyName) ?? "?"
		let uid = stringProp(device, kAudioDevicePropertyDeviceUID) ?? "?"
		let subs = subdeviceUIDs(device)
		let subNote = subs.isEmpty ? "" : " subs=\(subs.joined(separator: ","))"
		print("would play on \(name) uid=\(uid)\(subNote); \(routeNote(device)); system default unchanged")
		exit(0)
	}
	if let left = args.left, let right = args.right {
		if args.stereo != nil { fail("pass a stereo file or --left and --right, not both") }
		try playSplit(leftPath: left, rightPath: right, device: device, once: args.once, label: "\(left) | \(right)")
	} else if args.left != nil || args.right != nil {
		fail("--left and --right are both required")
	} else if let stereo = args.stereo {
		try playStereo(path: stereo, device: device, once: args.once)
	} else {
		fail("pass a stereo wav, or --left and --right")
	}
} catch {
	fail("\(error)")
}
