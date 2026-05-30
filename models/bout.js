const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Bout = sequelize.define('Bout', {
    pool_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'pool_id'
    },
    phase_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: 'phase_id'
    },
    left_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: 'left_id'
    },
    right_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: 'right_id'
    },
    left_score: DataTypes.INTEGER,
    right_score: DataTypes.INTEGER,
    winner_id: DataTypes.INTEGER,
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'pending'
    },
    strip_id: DataTypes.INTEGER,
    referee_id: DataTypes.INTEGER
  }, {
    tableName: 'bouts',
    timestamps: false
  });
  Bout.associate = models => {
    Bout.belongsTo(models.Pool, { foreignKey: 'pool_id' });
    Bout.belongsTo(models.Phase, { foreignKey: 'phase_id' });
    Bout.belongsTo(models.Competitor, { as: 'LeftCompetitor', foreignKey: 'left_id' });
    Bout.belongsTo(models.Competitor, { as: 'RightCompetitor', foreignKey: 'right_id' });
    Bout.belongsTo(models.Competitor, { as: 'Winner', foreignKey: 'winner_id' });
    Bout.belongsTo(models.Strip, { foreignKey: 'strip_id' });
    Bout.belongsTo(models.Referee, { foreignKey: 'referee_id' });
  };
  return Bout;
};
