const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Pool = sequelize.define('Pool', {
    phase_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: 'phase_id'
    },
    pool_number: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    strip_id: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    referee_id: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'pending'
    }
  }, {
    tableName: 'pools',
    timestamps: false
  });
  Pool.associate = models => {
    Pool.belongsTo(models.Phase, { foreignKey: 'phase_id' });
    Pool.belongsTo(models.Strip, { foreignKey: 'strip_id' });
    Pool.belongsTo(models.Referee, { foreignKey: 'referee_id' });
    Pool.hasMany(models.PoolCompetitor, { foreignKey: 'pool_id' });
    Pool.hasMany(models.Bout, { foreignKey: 'pool_id' });
  };
  return Pool;
};
