// Centralizes and initializes all Sequelize models and associations
const { Sequelize } = require('sequelize');
const NOCModel = require('./noc');
const ClubModel = require('./club');
const PersonModel = require('./person');
const FencerModel = require('./fencer');

const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: './db/database.sqlite',
  logging: false
});

const models = {};
models.NOC = NOCModel(sequelize);
models.Club = ClubModel(sequelize);
models.Person = PersonModel(sequelize);
models.Fencer = FencerModel(sequelize);
models.Competition = require('./competition')(sequelize);
models.CompetitionFencer = require('./competitionfencer')(sequelize);

// Set up associations
Object.values(models).forEach(model => {
  if (model.associate) model.associate(models);
});

models.sequelize = sequelize;
models.Sequelize = Sequelize;

module.exports = models;
