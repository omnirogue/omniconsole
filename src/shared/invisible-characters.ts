// Format and default-ignorable code points: zero-width, bidi controls, tag characters, soft hyphen.
export const IGNORABLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu
