const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Ranking = sequelize.define('Ranking', {
    phase_id: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    competitor_id: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    position: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    victories: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0
    },
    indicator: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0
    },
    touches_scored: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0
    },
    touches_received: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0
    },
    advanced: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0
    }
  }, {
    tableName: 'rankings',
    timestamps: false
  });
  Ranking.associate = models => {
    Ranking.belongsTo(models.Phase, { foreignKey: 'phase_id' });
    Ranking.belongsTo(models.Competitor, { foreignKey: 'competitor_id' });
  };
  return Ranking;
};
