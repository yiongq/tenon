/**
 * Inspector types (spec 02 §Inspector 接口与合议). Plan step 5 declares only the two category types
 * the `flagged` approval reason needs; the rest of this file's declarations land in step 9, in the
 * shapes the spec gives them.
 */

export type InspectorCategory = 'exfiltration' // what an inspector may report; only ever added to
/** The second value is produced by the kernel alone; shared by `flagged` cards and `inspector` blocks. */
export type FlaggedCategory = InspectorCategory | 'inspector-failed'
