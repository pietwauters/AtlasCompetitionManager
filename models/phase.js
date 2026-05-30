const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Phase = sequelize.define('Phase', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    competition_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'competitions',
        key: 'id'
      }
    },
    phase_order: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    type: {
      type: DataTypes.STRING,
      allowNull: false
    },
    rule_doc: {
      type: DataTypes.STRING,
      allowNull: false
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'pending'
    }
  }, {
    tableName: 'phases',
    timestamps: false
  });

  Phase.associate = models => {
    Phase.belongsTo(models.Competition, { foreignKey: 'competition_id' });
    // Add associations to pools, rankings, etc. if needed
  };

  return Phase;
};
