-- Manual/auto-ranked order of referees within a tournament or competition
-- roster (FIE Technical Rules t.50.3: Refereeing Delegates "establish a list
-- of the best referees at each weapon"). NULL until ranked; unranked rows
-- sort after ranked ones (see services/tournamentReferees.js and
-- services/competitionReferees.js).
ALTER TABLE tournament_referees  ADD COLUMN rank_order INTEGER;
ALTER TABLE competition_referees ADD COLUMN rank_order INTEGER;
