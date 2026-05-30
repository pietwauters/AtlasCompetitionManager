const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Competitor = sequelize.define('Competitor', {
    competition_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: 'competition_id'
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false
    },
    first_name: DataTypes.STRING,
    last_name: DataTypes.STRING,
    date_of_birth: DataTypes.STRING,
    gender: DataTypes.STRING,
    weapons: DataTypes.STRING,
    licence: DataTypes.STRING,
    handedness: DataTypes.STRING,
    national_ranking: DataTypes.INTEGER,
    club: DataTypes.STRING,
    nationality: DataTypes.STRING,
    initial_seed: DataTypes.INTEGER,
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'active'
    },
    final_rank: DataTypes.INTEGER
  }, {
    tableName: 'competitors',
    timestamps: false
  });
  Competitor.associate = models => {
    Competitor.belongsTo(models.Competition, { foreignKey: 'competition_id' });
  };
  return Competitor;
};
