import { DialogueSegment, SpeakerInfo } from '../types.js';
import { logger } from '../utils/logger.js';

export class SpeakerDetector {
  /**
   * Group segments by speaker, normalize speaker IDs, assign gender
   */
  public static identifySpeakers(segments: DialogueSegment[]): SpeakerInfo[] {
    const speakerMap = new Map<string, DialogueSegment[]>();

    // Standardize speaker names (speaker_1, speaker_2, etc.)
    const speakerAliasMap = new Map<string, string>();
    let speakerCounter = 1;

    for (const seg of segments) {
      let rawSpeaker = (seg.speaker || '').trim() || 'speaker_1';
      // Normalize 'Speaker 1', 'Speaker A', 'Person 1', etc.
      let normalizedKey = rawSpeaker.toLowerCase().replace(/\s+/g, '_');

      if (!speakerAliasMap.has(normalizedKey)) {
        const canonicalId = `speaker_${speakerCounter++}`;
        speakerAliasMap.set(normalizedKey, canonicalId);
      }

      const assignedId = speakerAliasMap.get(normalizedKey)!;
      seg.speaker = assignedId;

      if (!speakerMap.has(assignedId)) {
        speakerMap.set(assignedId, []);
      }
      speakerMap.get(assignedId)!.push(seg);
    }

    // Assign gender and voice characteristics
    const speakers: SpeakerInfo[] = [];

    let index = 0;
    for (const [speakerId, segList] of speakerMap.entries()) {
      // Analyze text context or voice hint for gender determination
      let gender: 'male' | 'female' | 'neutral' = 'neutral';

      // Alternate default male/female for conversational diversity if not explicitly specified
      if (index === 0) {
        gender = 'male';
      } else if (index === 1) {
        gender = 'female';
      } else {
        gender = index % 2 === 0 ? 'male' : 'female';
      }

      // Check if any segment already has gender hint
      const explicit = segList.find(s => s.speakerGender);
      if (explicit && explicit.speakerGender) {
        gender = explicit.speakerGender;
      }

      segList.forEach(s => {
        s.speakerGender = gender;
      });

      speakers.push({
        speakerId,
        gender,
        segments: segList,
      });

      index++;
    }

    logger.info(`Detected ${speakers.length} speakers across ${segments.length} dialogue segments.`);
    return speakers;
  }
}
