// Centralizes and initializes all Sequelize models and associations
const { Sequelize } = require('sequelize');
const NOCModel = require('./noc');
const ClubModel = require('./club');
const PersonModel = require('./person');
const FencerModel = require('./fencer');
const UserModel = require('./user');
const StripModel = require('./strip');
const RefereeModel = require('./referee');
const CompetitorModel = require('./competitor');
const PhaseModel = require('./phase');
const RankingModel = require('./ranking');
const PoolModel = require('./pool');
const PoolCompetitorModel = require('./poolcompetitor');
const BoutModel = require('./bout');
const TournamentModel = require('./tournament');

const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: './data/atlas.db',
  logging: false
});

const models = {};
models.NOC = NOCModel(sequelize);
models.Club = ClubModel(sequelize);
models.Person = PersonModel(sequelize);
models.Fencer = FencerModel(sequelize);
models.User = UserModel(sequelize);
models.Strip = StripModel(sequelize);
models.Referee = RefereeModel(sequelize);
models.Competitor = CompetitorModel(sequelize);
models.Phase = PhaseModel(sequelize);
models.Ranking = RankingModel(sequelize);
models.Pool = PoolModel(sequelize);
models.PoolCompetitor = PoolCompetitorModel(sequelize);
models.Bout = BoutModel(sequelize);
models.Competition = require('./competition')(sequelize);
models.CompetitionFencer = require('./competitionfencer')(sequelize);
models.Tournament = TournamentModel(sequelize);


// Set up associations for all models
Object.values(models).forEach(model => {
  if (model.associate) model.associate(models);
});

// Additional explicit associations for clarity and Sequelize sync
// Competition <-> Competitor (legacy table)
models.Competition.hasMany(models.Competitor, { foreignKey: 'competition_id' });
models.Competitor.belongsTo(models.Competition, { foreignKey: 'competition_id' });

// Phase <-> Competition
models.Competition.hasMany(models.Phase, { foreignKey: 'competition_id' });
models.Phase.belongsTo(models.Competition, { foreignKey: 'competition_id' });

// Phase <-> Pool
models.Phase.hasMany(models.Pool, { foreignKey: 'phase_id' });
models.Pool.belongsTo(models.Phase, { foreignKey: 'phase_id' });

// Pool <-> PoolCompetitor
models.Pool.hasMany(models.PoolCompetitor, { foreignKey: 'pool_id' });
models.PoolCompetitor.belongsTo(models.Pool, { foreignKey: 'pool_id' });

// PoolCompetitor <-> Competitor
models.Competitor.hasMany(models.PoolCompetitor, { foreignKey: 'competitor_id' });
models.PoolCompetitor.belongsTo(models.Competitor, { foreignKey: 'competitor_id' });

// Pool <-> Bout
models.Pool.hasMany(models.Bout, { foreignKey: 'pool_id' });
models.Bout.belongsTo(models.Pool, { foreignKey: 'pool_id' });

// Phase <-> Bout
models.Phase.hasMany(models.Bout, { foreignKey: 'phase_id' });
models.Bout.belongsTo(models.Phase, { foreignKey: 'phase_id' });

// Bout <-> Competitor (left, right, winner)
// Associations with alias are defined in Bout.associate only to avoid duplicate alias errors

// Pool <-> Strip, Referee
models.Strip.hasMany(models.Pool, { foreignKey: 'strip_id' });
models.Pool.belongsTo(models.Strip, { foreignKey: 'strip_id' });
models.Referee.hasMany(models.Pool, { foreignKey: 'referee_id' });
models.Pool.belongsTo(models.Referee, { foreignKey: 'referee_id' });

// Bout <-> Strip, Referee
models.Strip.hasMany(models.Bout, { foreignKey: 'strip_id' });
models.Bout.belongsTo(models.Strip, { foreignKey: 'strip_id' });
models.Referee.hasMany(models.Bout, { foreignKey: 'referee_id' });
models.Bout.belongsTo(models.Referee, { foreignKey: 'referee_id' });

// Phase <-> Ranking
models.Phase.hasMany(models.Ranking, { foreignKey: 'phase_id' });
models.Ranking.belongsTo(models.Phase, { foreignKey: 'phase_id' });

// Competitor <-> Ranking
models.Competitor.hasMany(models.Ranking, { foreignKey: 'competitor_id' });
models.Ranking.belongsTo(models.Competitor, { foreignKey: 'competitor_id' });

models.sequelize = sequelize;
models.Sequelize = Sequelize;

module.exports = models;
