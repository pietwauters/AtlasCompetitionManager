const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const PoolCompetitor = sequelize.define('PoolCompetitor', {
    pool_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      field: 'pool_id'
    },
    competitor_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      field: 'competitor_id'
    }
  }, {
    tableName: 'pool_competitors',
    timestamps: false
  });
  PoolCompetitor.associate = models => {
    PoolCompetitor.belongsTo(models.Pool, { foreignKey: 'pool_id' });
    PoolCompetitor.belongsTo(models.Competitor, { foreignKey: 'competitor_id' });
  };
  return PoolCompetitor;
};
