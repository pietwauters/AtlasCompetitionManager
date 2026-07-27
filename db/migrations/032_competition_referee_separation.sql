-- Competition-level setting for which fencer attribute(s) referee/official
-- assignment neutrality should consider (nationality and/or club) — distinct
-- from poolFormation.separation, which governs fencer-vs-fencer pool
-- separation per rule file/phase, not referee-vs-fencer neutrality.
-- Comma-separated, same value vocabulary as competition-detail.html's
-- pool-separation picker: '', 'club', 'nationality', 'nationality,club'.
-- Storage + UI only for now — not yet consumed by any assignment check.
ALTER TABLE competitions ADD COLUMN referee_separation TEXT;
