-- Mirror of max_de_tableau (migration 040): "largest tableau this piste may
-- host" already lets Podium be restricted to semis/final only. The reverse
-- case is just as real — "colored/video pistes only, from T32 down" means
-- the *regular* pistes must drop out once a round shrinks below a
-- threshold, which max_de_tableau alone can't express. min_de_tableau =
-- "smallest tableau this piste may host"; NULL (the default) means no lower
-- bound, identical to today's behavior for every existing row.

ALTER TABLE strips ADD COLUMN min_de_tableau INTEGER;
